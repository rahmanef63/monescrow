// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title Escrow
/// @notice One freelance agreement, funded up front in native MON and released
///         milestone by milestone as each one is shown to be done.
///
/// @dev The design decision that matters: **the verifier proposes, it does not decide.**
///      A passing attestation does not move money — it starts a challenge window. If the
///      client stays silent for the whole window, anyone may trigger the release. If the
///      client objects, the milestone freezes and only the arbiter can unfreeze it. That
///      keeps an off-chain checker (and any AI inside it) out of the position of
///      unilaterally moving somebody's funds, while still letting an honest freelancer
///      get paid without chasing anyone.
///
///      Testnet demo contract. NOT AUDITED. Do not use with real funds.
/// @dev Uses OpenZeppelin's transient-storage reentrancy guard (EIP-1153). Verified
///      supported on Monad testnet before adopting it — see the note in foundry.toml.
///      Worth it here: the classic guard costs a cold SSTORE, which Monad prices at
///      8,100 gas versus Ethereum's 2,100, and on Monad the user pays the gas limit.
contract Escrow is EIP712, ReentrancyGuardTransient {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// How a milestone is meant to be checked. Purely informational on-chain — the
    /// contract never runs a check itself, it only records what the parties agreed to
    /// and who is allowed to attest to the outcome.
    enum Check {
        ClientApproval, // no automated check; the client releases by hand
        Http, // verifier fetches a URL and asserts status + required content
        Github // verifier asks the GitHub API about a commit / check-run
    }

    enum MState {
        Pending, // nothing submitted yet
        Submitted, // freelancer submitted evidence, awaiting attestation or approval
        Attested, // verifier signed a pass — challenge window running
        Released, // paid out to the freelancer
        Disputed, // client objected — frozen until the arbiter rules
        Refunded // returned to the client
    }

    struct Milestone {
        uint128 amount; // wei of native MON
        Check check;
        MState state;
        uint32 submissions; // bumped on every submit; invalidates older attestations
        uint64 attestedAt; // when the passing attestation landed
        bytes32 criteriaHash; // hash of the agreed acceptance criteria (stored off-chain)
        bytes32 evidenceHash; // hash of the most recent submission
    }

    struct MilestoneInit {
        uint128 amount;
        Check check;
        bytes32 criteriaHash;
    }

    struct Params {
        address freelancer;
        address verifier;
        address arbiter;
        uint64 deadline;
        uint32 challengeWindow;
        bytes32 termsHash;
        string title;
    }

    struct Summary {
        address escrow;
        address client;
        address freelancer;
        address verifier;
        address arbiter;
        uint256 totalAmount;
        uint256 releasedAmount;
        uint256 refundedAmount;
        uint64 deadline;
        uint32 challengeWindow;
        uint64 acceptedAt;
        bool cancelled;
        bytes32 termsHash;
        string title;
        uint256 accountOwed;
    }

    /// @dev EIP-712 payload the verifier signs. The domain already pins chain id and this
    ///      contract's address, so an attestation cannot be replayed onto another escrow
    ///      or another chain. `submission` and `evidenceHash` pin it to one exact
    ///      submission, so a freelancer cannot swap the deliverable after the fact and a
    ///      stale pass cannot be reused after a resubmit.
    bytes32 private constant ATTESTATION_TYPEHASH = keccak256(
        "Attestation(uint256 milestone,uint32 submission,bool passed,bytes32 evidenceHash,bytes32 reportHash)"
    );

    uint256 public constant MAX_MILESTONES = 20;
    uint256 public constant MAX_TITLE_BYTES = 120;

    /// @notice Bounds on the challenge window. Both ends are load-bearing. (D-7)
    /// @dev **Zero is the dangerous one.** With `challengeWindow == 0`, `release` computes
    ///      `openUntil == attestedAt == block.timestamp`, so whoever holds the verifier key
    ///      can `attest(passed=true)` and `release` in a single transaction and the client
    ///      never gets a chance to `dispute`. That makes the off-chain verifier a unilateral
    ///      authority over the client's funds — the exact thing this contract's design note
    ///      says must never happen. A weak check is survivable only because the window
    ///      exists; a zero window removes the mechanism while keeping the claim.
    ///
    ///      The upper bound is a liveness guard rather than a security one. `reclaim` accepts
    ///      only Pending/Submitted, so an `Attested` milestone with an absurd window can
    ///      neither be reclaimed after the deadline nor released until the window elapses —
    ///      the funds sit with no exit but `approve` or `dispute`. `uint32` would otherwise
    ///      allow ~136 years.
    uint32 public constant MIN_CHALLENGE_WINDOW = 60;
    uint32 public constant MAX_CHALLENGE_WINDOW = 30 days;

    /*//////////////////////////////////////////////////////////////
                                 STATE
    //////////////////////////////////////////////////////////////*/

    address public immutable client;
    address public immutable freelancer;
    address public immutable verifier;
    address public immutable arbiter;

    /// @notice No submission is accepted after this, and the client may reclaim whatever
    ///         has not been earned by then.
    uint64 public immutable deadline;

    /// @notice Seconds the client has to object after a passing attestation.
    uint32 public immutable challengeWindow;

    /// @notice Total escrowed at construction — equals the sum of all milestone amounts.
    uint256 public immutable totalAmount;

    /// @notice Hash of the full agreement text both sides saw before signing.
    bytes32 public immutable termsHash;

    string public title;

    /// @notice Set when the freelancer accepts. Work cannot be submitted before this.
    uint64 public acceptedAt;

    /// @notice Set if the client pulled out before the freelancer ever accepted.
    bool public cancelled;

    uint256 public releasedAmount;
    uint256 public refundedAmount;

    Milestone[] private _milestones;

    /// @notice Pull-based balances. Nothing is ever pushed to anyone.
    mapping(address account => uint256 amount) public owed;

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    event Accepted(address indexed freelancer, uint64 at);
    event Cancelled(address indexed client, uint256 amount);
    event Submitted(uint256 indexed milestone, uint32 submission, bytes32 evidenceHash);
    event AttestationPassed(uint256 indexed milestone, uint32 submission, bytes32 reportHash, uint64 releasableAt);
    event AttestationFailed(uint256 indexed milestone, uint32 submission, bytes32 reportHash);
    event Released(uint256 indexed milestone, uint256 amount, string reason);
    event Refunded(uint256 indexed milestone, uint256 amount, string reason);
    event Disputed(uint256 indexed milestone, address indexed by);
    event DisputeResolved(uint256 indexed milestone, bool toFreelancer);
    event Withdrawn(address indexed account, uint256 amount);

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAddress();
    error ClientIsFreelancer();
    error VerifierRequired();
    error DeadlineInPast();
    error NoMilestones();
    error TooManyMilestones();
    error ZeroMilestoneAmount();
    error FundingMismatch(uint256 expected, uint256 sent);
    error TitleEmpty();
    error TitleTooLong();
    error ChallengeWindowOutOfRange(uint32 given, uint32 min, uint32 max);

    error NotClient();
    error NotFreelancer();
    error NotArbiter();
    error BadMilestone();

    error AlreadyAccepted();
    error NotAccepted();
    error EscrowCancelled();
    error AlreadyStarted();
    error DeadlinePassed();
    error DeadlineNotPassed();

    error WrongState(MState actual);
    error StaleSubmission(uint32 expected, uint32 got);
    error BadSignature();
    error ChallengeWindowOpen(uint64 releasableAt);
    error NothingOwed();
    error TransferFailed();

    /*//////////////////////////////////////////////////////////////
                              CONSTRUCTION
    //////////////////////////////////////////////////////////////*/

    /// @param client_ Party funding the work. Must be the caller of the factory.
    /// @param p       Counterparty, oracle roles, timing and the agreement hash.
    /// @param ms      Milestones. Amounts must sum to exactly `msg.value`.
    constructor(address client_, Params memory p, MilestoneInit[] memory ms) payable EIP712("MonEscrow", "1") {
        if (client_ == address(0) || p.freelancer == address(0)) revert ZeroAddress();
        if (client_ == p.freelancer) revert ClientIsFreelancer();
        if (p.arbiter == address(0)) revert ZeroAddress();
        if (p.deadline <= block.timestamp) revert DeadlineInPast();
        if (p.challengeWindow < MIN_CHALLENGE_WINDOW || p.challengeWindow > MAX_CHALLENGE_WINDOW) {
            revert ChallengeWindowOutOfRange(p.challengeWindow, MIN_CHALLENGE_WINDOW, MAX_CHALLENGE_WINDOW);
        }

        uint256 len = ms.length;
        if (len == 0) revert NoMilestones();
        if (len > MAX_MILESTONES) revert TooManyMilestones();

        uint256 titleLen = bytes(p.title).length;
        if (titleLen == 0) revert TitleEmpty();
        if (titleLen > MAX_TITLE_BYTES) revert TitleTooLong();

        uint256 sum;
        bool needsVerifier;
        for (uint256 i = 0; i < len; ++i) {
            if (ms[i].amount == 0) revert ZeroMilestoneAmount();
            sum += ms[i].amount;
            if (ms[i].check != Check.ClientApproval) needsVerifier = true;

            _milestones.push(
                Milestone({
                    amount: ms[i].amount,
                    check: ms[i].check,
                    state: MState.Pending,
                    submissions: 0,
                    attestedAt: 0,
                    criteriaHash: ms[i].criteriaHash,
                    evidenceHash: bytes32(0)
                })
            );
        }

        // A milestone that expects an automated check is unreleasable without someone to
        // sign for it, so refuse to create an escrow that could strand funds.
        if (needsVerifier && p.verifier == address(0)) revert VerifierRequired();
        if (sum != msg.value) revert FundingMismatch(sum, msg.value);

        client = client_;
        freelancer = p.freelancer;
        verifier = p.verifier;
        arbiter = p.arbiter;
        deadline = p.deadline;
        challengeWindow = p.challengeWindow;
        termsHash = p.termsHash;
        totalAmount = sum;
        title = p.title;
    }

    /*//////////////////////////////////////////////////////////////
                             AGREEMENT SETUP
    //////////////////////////////////////////////////////////////*/

    /// @notice Freelancer signals agreement to the exact terms hashed at construction.
    /// @dev Nothing can be submitted until this happens, so the money is never at work
    ///      under terms only one side has seen.
    function accept() external {
        if (msg.sender != freelancer) revert NotFreelancer();
        if (cancelled) revert EscrowCancelled();
        if (acceptedAt != 0) revert AlreadyAccepted();
        if (block.timestamp >= deadline) revert DeadlinePassed();

        acceptedAt = uint64(block.timestamp);
        emit Accepted(freelancer, acceptedAt);
    }

    /// @notice Client pulls out while the offer is still unaccepted, reclaiming everything.
    function cancel() external {
        if (msg.sender != client) revert NotClient();
        if (cancelled) revert EscrowCancelled();
        if (acceptedAt != 0) revert AlreadyStarted();

        cancelled = true;

        uint256 len = _milestones.length;
        uint256 amount;
        for (uint256 i = 0; i < len; ++i) {
            Milestone storage m = _milestones[i];
            if (m.state == MState.Pending) {
                m.state = MState.Refunded;
                amount += m.amount;
                emit Refunded(i, m.amount, "cancelled before acceptance");
            }
        }

        refundedAmount += amount;
        owed[client] += amount;
        emit Cancelled(client, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                  WORK
    //////////////////////////////////////////////////////////////*/

    /// @notice Freelancer submits evidence for a milestone. Re-submitting after a failed
    ///         attestation bumps the submission counter, which invalidates every
    ///         attestation signed against the previous attempt.
    function submit(uint256 i, bytes32 evidenceHash) external {
        if (msg.sender != freelancer) revert NotFreelancer();
        if (acceptedAt == 0) revert NotAccepted();
        if (block.timestamp >= deadline) revert DeadlinePassed();

        Milestone storage m = _milestone(i);
        if (m.state != MState.Pending && m.state != MState.Submitted) revert WrongState(m.state);

        m.state = MState.Submitted;
        m.submissions += 1;
        m.evidenceHash = evidenceHash;

        emit Submitted(i, m.submissions, evidenceHash);
    }

    /// @notice Relay a verifier attestation. Anyone may submit it — the signature is what
    ///         counts, not the sender — so a freelancer can post their own passing result
    ///         and pay the gas themselves.
    /// @param submission Must equal the milestone's current submission counter.
    /// @param reportHash Hash of the full machine-readable check report, kept off-chain.
    function attest(uint256 i, uint32 submission, bool passed, bytes32 reportHash, bytes calldata signature) external {
        Milestone storage m = _milestone(i);
        if (m.state != MState.Submitted) revert WrongState(m.state);
        if (submission != m.submissions) revert StaleSubmission(m.submissions, submission);

        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(ATTESTATION_TYPEHASH, i, submission, passed, m.evidenceHash, reportHash))
        );
        address signer = ECDSA.recover(digest, signature);
        if (signer != verifier || verifier == address(0)) revert BadSignature();

        if (!passed) {
            // The freelancer iterates and submits again. No state change, so a failing
            // report can never be used to strand the milestone.
            emit AttestationFailed(i, submission, reportHash);
            return;
        }

        m.state = MState.Attested;
        m.attestedAt = uint64(block.timestamp);
        emit AttestationPassed(i, submission, reportHash, uint64(block.timestamp) + challengeWindow);
    }

    /// @notice Client releases a milestone by hand, skipping any wait.
    /// @dev Always available, whether or not a verifier ever looked at it. This is the
    ///      escape hatch for everything an automated check cannot judge.
    function approve(uint256 i) external {
        if (msg.sender != client) revert NotClient();

        Milestone storage m = _milestone(i);
        if (m.state != MState.Submitted && m.state != MState.Attested) revert WrongState(m.state);

        _release(i, m, "client approved");
    }

    /// @notice Release a milestone whose challenge window has run out without objection.
    /// @dev Callable by anyone: the client's silence is the authorisation, so the
    ///      freelancer never has to chase them.
    function release(uint256 i) external {
        Milestone storage m = _milestone(i);
        if (m.state != MState.Attested) revert WrongState(m.state);

        uint64 openUntil = m.attestedAt + challengeWindow;
        if (block.timestamp < openUntil) revert ChallengeWindowOpen(openUntil);

        _release(i, m, "challenge window elapsed");
    }

    /// @notice Client objects to a submission or a passing attestation. Freezes the
    ///         milestone until the arbiter rules.
    function dispute(uint256 i) external {
        if (msg.sender != client) revert NotClient();

        Milestone storage m = _milestone(i);
        if (m.state != MState.Submitted && m.state != MState.Attested) revert WrongState(m.state);

        m.state = MState.Disputed;
        emit Disputed(i, msg.sender);
    }

    /// @notice Arbiter rules on a frozen milestone.
    function resolveDispute(uint256 i, bool toFreelancer) external {
        if (msg.sender != arbiter) revert NotArbiter();

        Milestone storage m = _milestone(i);
        if (m.state != MState.Disputed) revert WrongState(m.state);

        emit DisputeResolved(i, toFreelancer);
        if (toFreelancer) {
            _release(i, m, "dispute resolved for freelancer");
        } else {
            _refund(i, m, "dispute resolved for client");
        }
    }

    /// @notice After the deadline, the client reclaims every milestone that was never
    ///         earned. A milestone already inside its challenge window is excluded — that
    ///         work was proven in time and can still be released.
    function reclaim(uint256 i) external {
        if (msg.sender != client) revert NotClient();
        if (block.timestamp < deadline) revert DeadlineNotPassed();

        Milestone storage m = _milestone(i);
        if (m.state != MState.Pending && m.state != MState.Submitted) revert WrongState(m.state);

        _refund(i, m, "deadline passed unearned");
    }

    /*//////////////////////////////////////////////////////////////
                                 PAYOUT
    //////////////////////////////////////////////////////////////*/

    /// @notice Withdraw everything credited to the caller. Pull-based, never pushed.
    function withdraw() external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert NothingOwed();

        owed[msg.sender] = 0; // effect before interaction

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();

        emit Withdrawn(msg.sender, amount);
    }

    /*//////////////////////////////////////////////////////////////
                                  VIEWS
    //////////////////////////////////////////////////////////////*/

    function milestoneCount() external view returns (uint256) {
        return _milestones.length;
    }

    function milestones() external view returns (Milestone[] memory) {
        return _milestones;
    }

    function milestoneAt(uint256 i) external view returns (Milestone memory) {
        return _milestone(i);
    }

    /// @notice Timestamp a passing milestone becomes releasable, or 0 if not applicable.
    function releasableAt(uint256 i) external view returns (uint64) {
        Milestone storage m = _milestone(i);
        if (m.state != MState.Attested) return 0;
        return m.attestedAt + challengeWindow;
    }

    /// @notice Seconds left in the challenge window, 0 once it has elapsed.
    function challengeRemaining(uint256 i) external view returns (uint256) {
        Milestone storage m = _milestone(i);
        if (m.state != MState.Attested) return 0;
        uint64 at = m.attestedAt + challengeWindow;
        if (block.timestamp >= at) return 0;
        return at - block.timestamp;
    }

    function summary(address account) external view returns (Summary memory s) {
        s.escrow = address(this);
        s.client = client;
        s.freelancer = freelancer;
        s.verifier = verifier;
        s.arbiter = arbiter;
        s.totalAmount = totalAmount;
        s.releasedAmount = releasedAmount;
        s.refundedAmount = refundedAmount;
        s.deadline = deadline;
        s.challengeWindow = challengeWindow;
        s.acceptedAt = acceptedAt;
        s.cancelled = cancelled;
        s.termsHash = termsHash;
        s.title = title;
        s.accountOwed = owed[account];
    }

    /// @notice Digest a verifier must sign for a given attestation. Exposed so the
    ///         off-chain verifier and any reviewer can reproduce it exactly.
    function attestationDigest(uint256 i, uint32 submission, bool passed, bytes32 evidenceHash, bytes32 reportHash)
        external
        view
        returns (bytes32)
    {
        return
            _hashTypedDataV4(
                keccak256(abi.encode(ATTESTATION_TYPEHASH, i, submission, passed, evidenceHash, reportHash))
            );
    }

    /*//////////////////////////////////////////////////////////////
                                INTERNAL
    //////////////////////////////////////////////////////////////*/

    function _milestone(uint256 i) internal view returns (Milestone storage) {
        if (i >= _milestones.length) revert BadMilestone();
        return _milestones[i];
    }

    function _release(uint256 i, Milestone storage m, string memory reason) internal {
        m.state = MState.Released;
        uint256 amount = m.amount;
        releasedAmount += amount;
        owed[freelancer] += amount;
        emit Released(i, amount, reason);
    }

    function _refund(uint256 i, Milestone storage m, string memory reason) internal {
        m.state = MState.Refunded;
        uint256 amount = m.amount;
        refundedAmount += amount;
        owed[client] += amount;
        emit Refunded(i, amount, reason);
    }
}
