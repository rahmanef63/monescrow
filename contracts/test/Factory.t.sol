// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {Escrow} from "../src/Escrow.sol";
import {EscrowFactory} from "../src/EscrowFactory.sol";

/// @notice The factory is the only index the frontend has — no subgraph, no backend. If a
///         job is missing from `escrowsOf`, mis-ordered in a page, or the factory quietly
///         keeps a slice of the funding, the dashboard lies to somebody about their money.
///         These tests pin the index and the value forwarding.
contract FactoryTest is BaseTest {
    /*//////////////////////////////////////////////////////////////
                            LOCAL HELPERS
    //////////////////////////////////////////////////////////////*/

    /// @dev `n` escrows from the same client/freelancer pair, returned in creation order.
    function _createMany(uint256 n) private returns (address[] memory made) {
        made = new address[](n);
        for (uint256 i = 0; i < n; ++i) {
            made[i] = address(_newEscrow());
        }
    }

    /*//////////////////////////////////////////////////////////////
                              THE INDEX
    //////////////////////////////////////////////////////////////*/

    /// Every created escrow must land in all three index structures at once — the array,
    /// the counter and the membership map. A dashboard that reads any one of them alone
    /// must see the same job, otherwise a funded agreement disappears from someone's list.
    function test_CreateEscrowAppendsToTheIndex() public {
        assertEq(factory.escrowCount(), 0, "factory starts empty");

        address first = address(_newEscrow());

        assertEq(factory.escrowCount(), 1, "count bumped by the first escrow");
        assertEq(factory.escrows(0), first, "array holds the first escrow at slot 0");
        assertTrue(factory.isEscrow(first), "first escrow is recognised");

        address second = address(_newEscrow());

        assertEq(factory.escrowCount(), 2, "count bumped by the second escrow");
        assertEq(factory.escrows(1), second, "array appends, it does not overwrite");
        assertEq(factory.escrows(0), first, "the first escrow is still at slot 0");
        assertTrue(factory.isEscrow(second), "second escrow is recognised");
        assertTrue(first != second, "two distinct deployments");
    }

    /// `isEscrow` is the frontend's only trust signal: it must be true for exactly the
    /// contracts this factory deployed. An Escrow someone deploys themselves — with any
    /// client, freelancer or terms they like — must never be able to claim provenance.
    function test_IsEscrowIsFalseForAnythingNotFromTheFactory() public {
        _newEscrow();
        uint256 countBefore = factory.escrowCount();
        uint256 clientListBefore = factory.escrowCountOf(client);
        uint256 freelancerListBefore = factory.escrowCountOf(freelancer);

        vm.deal(address(this), TOTAL);
        Escrow rogue = new Escrow{value: TOTAL}(client, _params(), _defaultMilestones());

        assertFalse(factory.isEscrow(address(rogue)), "a directly deployed Escrow is not ours");
        assertFalse(factory.isEscrow(makeAddr("nobody")), "a random address is not an escrow");
        assertFalse(factory.isEscrow(stranger), "an EOA is not an escrow");
        assertFalse(factory.isEscrow(address(0)), "the zero address is not an escrow");
        assertFalse(factory.isEscrow(address(factory)), "the factory is not one of its own escrows");

        assertEq(factory.escrowCount(), countBefore, "a direct deployment does not touch the index");
        assertEq(factory.escrowCountOf(client), clientListBefore, "nor the client's list");
        assertEq(factory.escrowCountOf(freelancer), freelancerListBefore, "nor the freelancer's list");
    }

    /// The EscrowCreated log is what a frontend backfills its cache from, so every field
    /// must be true at emit time — including `index`, which must be the slot the escrow
    /// actually occupies (the array length before the push), not a hardcoded zero.
    function test_EscrowCreatedCarriesEverythingADashboardNeeds() public {
        // Make one first, so a correct `index` is 1 — a bug that always emits 0 fails here.
        _newEscrow();
        uint256 indexBefore = factory.escrowCount();
        assertEq(indexBefore, 1, "one escrow already indexed");

        address predicted = vm.computeCreateAddress(address(factory), vm.getNonce(address(factory)));

        vm.expectEmit(true, true, true, true, address(factory));
        emit EscrowFactory.EscrowCreated(predicted, client, freelancer, TOTAL, 3, indexBefore);

        vm.prank(client);
        address created = factory.createEscrow{value: TOTAL}(_params(), _defaultMilestones());

        assertEq(created, predicted, "the logged escrow is the address that was returned");
        assertEq(factory.escrows(indexBefore), created, "the logged index is the slot it landed in");
        assertEq(Escrow(created).totalAmount(), TOTAL, "the logged totalAmount is the escrow's own total");
        assertEq(Escrow(created).milestoneCount(), 3, "the logged milestoneCount matches the escrow");
    }

    /*//////////////////////////////////////////////////////////////
                             PARTY LOOKUP
    //////////////////////////////////////////////////////////////*/

    /// One escrow must appear on both dashboards. The client and the freelancer each look
    /// up their own address and nothing else, so indexing only the caller would hide every
    /// job from the person doing the work.
    function test_EscrowsOfIndexesBothParties() public {
        address e = address(_newEscrow());

        address[] memory forClient = factory.escrowsOf(client);
        address[] memory forFreelancer = factory.escrowsOf(freelancer);

        assertEq(forClient.length, 1, "client sees exactly one job");
        assertEq(forClient[0], e, "and it is the escrow just created");
        assertEq(forFreelancer.length, 1, "freelancer sees exactly one job");
        assertEq(forFreelancer[0], e, "and it is the same escrow");

        assertEq(factory.escrowCountOf(client), forClient.length, "client count agrees with the list");
        assertEq(factory.escrowCountOf(freelancer), forFreelancer.length, "freelancer count agrees with the list");
    }

    /// Only the two parties whose money and work are at stake are indexed. Anyone else —
    /// including the arbiter and the verifier, who are named in the agreement — must get
    /// an empty list, or an unrelated wallet would show somebody else's contracts.
    function test_EscrowsOfIsEmptyForAThirdParty() public {
        _newEscrow();

        assertEq(factory.escrowsOf(stranger).length, 0, "an uninvolved wallet sees nothing");
        assertEq(factory.escrowCountOf(stranger), 0, "and its count is zero");
        assertEq(factory.escrowsOf(arbiter).length, 0, "the arbiter is not a party to the index");
        assertEq(factory.escrowsOf(verifier).length, 0, "the verifier is not a party to the index");
        assertEq(factory.escrowsOf(address(0)).length, 0, "the zero address indexes nothing");
    }

    /// Repeat business between the same two people must accumulate, oldest first, on both
    /// sides. Overwriting instead of appending would erase a client's earlier jobs.
    function test_RepeatBusinessGrowsBothPartyListsInOrder() public {
        address[] memory made = _createMany(3);

        address[] memory forClient = factory.escrowsOf(client);
        address[] memory forFreelancer = factory.escrowsOf(freelancer);

        assertEq(forClient, made, "client's list is every escrow in creation order");
        assertEq(forFreelancer, made, "freelancer's list is every escrow in creation order");
        assertEq(factory.escrowCountOf(client), 3, "client count agrees");
        assertEq(factory.escrowCountOf(freelancer), 3, "freelancer count agrees");
    }

    /*//////////////////////////////////////////////////////////////
                              PAGINATION
    //////////////////////////////////////////////////////////////*/

    /// The unpaginated read is the frontend's cold-start fetch: it must be the whole array,
    /// oldest first, with nothing dropped or reordered.
    function test_GetEscrowsReturnsEverythingInCreationOrder() public {
        address[] memory made = _createMany(4);

        address[] memory all = factory.getEscrows();

        assertEq(all.length, 4, "every escrow is returned");
        assertEq(all, made, "and in creation order");
    }

    /// A page must be the exact window asked for. An off-by-one here silently hides one
    /// job per page, or shows the same one twice.
    function test_PaginationReturnsTheRequestedSlice() public {
        address[] memory made = _createMany(5);

        address[] memory head = factory.getEscrows(0, 2);
        assertEq(head.length, 2, "first page is two long");
        assertEq(head[0], made[0], "first page starts at the oldest");
        assertEq(head[1], made[1], "first page is contiguous");

        address[] memory middle = factory.getEscrows(2, 2);
        assertEq(middle.length, 2, "second page is two long");
        assertEq(middle[0], made[2], "second page starts where the first stopped");
        assertEq(middle[1], made[3], "second page is contiguous");

        address[] memory one = factory.getEscrows(4, 1);
        assertEq(one.length, 1, "a single-item page is allowed");
        assertEq(one[0], made[4], "and holds the newest escrow");
    }

    /// The last page is always short. Asking for more than remains must clamp to what
    /// exists rather than revert, so a UI paging with a fixed page size never breaks on
    /// the final page. Every limit here is small enough that `offset + limit` computes
    /// without overflowing — that is the genuine clamp, and it works. The overflow
    /// boundary is a different story and lives in its own test below.
    function test_PaginationClampsALimitPastTheEnd() public {
        address[] memory made = _createMany(5);

        address[] memory tail = factory.getEscrows(3, 100);

        assertEq(tail.length, 2, "clamped to the two that remain");
        assertEq(tail[0], made[3], "tail starts at the offset");
        assertEq(tail[1], made[4], "tail ends at the newest");

        address[] memory everything = factory.getEscrows(0, type(uint128).max);
        assertEq(everything, made, "a limit far past the end is just the whole list");
    }

    /// `type(uint256).max` is the "give me everything from here" sentinel any frontend
    /// reaches for, and it must clamp from every offset rather than blow up. This used to
    /// be a defect: `end = offset + limit` was checked arithmetic, so the sentinel
    /// overflowed the addition and the call panicked with `Panic(0x11)` from any offset
    /// above zero — including `offset == length`, the natural stop condition of a paging
    /// loop. Reported as F-A in `contracts/test/FINDINGS.md`, fixed by A in
    /// `EscrowFactory.getEscrows` by clamping before adding. This test now pins the fixed
    /// behaviour; it was deliberately kept rather than deleted, because the boundary needs
    /// covering whichever way the contract answers.
    function test_PaginationClampsTheMaxSentinelFromEveryOffset() public {
        address[] memory made = _createMany(5);
        uint256 total = factory.escrowCount();

        address[] memory fromZero = factory.getEscrows(0, type(uint256).max);
        assertEq(fromZero, made, "from zero the sentinel is the whole list");

        address[] memory fromOne = factory.getEscrows(1, type(uint256).max);
        assertEq(fromOne.length, total - 1, "from one it is everything that remains");
        assertEq(fromOne[0], made[1], "and it starts at the offset");
        assertEq(fromOne[fromOne.length - 1], made[total - 1], "and ends at the newest");

        address[] memory fromLast = factory.getEscrows(total - 1, type(uint256).max);
        assertEq(fromLast.length, 1, "the last page holds exactly the last escrow");
        assertEq(fromLast[0], made[total - 1], "which is the newest");

        // The stop condition of a paging loop: everything has been read, so the honest
        // answer is an empty page rather than a revert.
        address[] memory atEnd = factory.getEscrows(total, type(uint256).max);
        assertEq(atEnd.length, 0, "offset == length is an empty page, not a panic");

        assertEq(factory.escrowCount(), total, "the index still holds every escrow");
        assertEq(factory.getEscrows(), made, "and the full read still agrees");
    }

    /// `offset == length` is the natural stop condition of a paging loop — the client has
    /// read everything. It must return an empty page, not revert, or the loop throws
    /// instead of finishing.
    function test_PaginationAtOffsetEqualToLengthReturnsEmpty() public {
        _createMany(3);
        uint256 total = factory.escrowCount();

        address[] memory past = factory.getEscrows(total, 10);

        assertEq(past.length, 0, "reading exactly at the end yields an empty page");
        assertEq(factory.escrowCount(), total, "and the index is untouched");
    }

    /// A zero limit asks for nothing and must get nothing back, at any valid offset.
    function test_PaginationWithZeroLimitReturnsEmpty() public {
        _createMany(3);

        assertEq(factory.getEscrows(0, 0).length, 0, "zero limit at the start returns nothing");
        assertEq(factory.getEscrows(2, 0).length, 0, "zero limit mid-list returns nothing");
        assertEq(factory.getEscrows(3, 0).length, 0, "zero limit at the end returns nothing");
    }

    /// An offset genuinely beyond the array is a caller bug, and must fail loudly rather
    /// than return an empty page that reads as "you have no jobs".
    function test_RevertWhen_PaginationOffsetIsPastTheEnd() public {
        _createMany(3);
        uint256 total = factory.escrowCount();
        uint256 tooFar = total + 1;

        vm.expectRevert(EscrowFactory.BadRange.selector);
        factory.getEscrows(tooFar, 1);

        assertEq(factory.escrowCount(), total, "the index still holds every escrow");
        assertEq(factory.getEscrows().length, total, "and the full read still works");
    }

    /*//////////////////////////////////////////////////////////////
                          MONEY FORWARDING
    //////////////////////////////////////////////////////////////*/

    /// The factory takes no fee and holds no float: every wei sent with `createEscrow`
    /// must end up inside that escrow. A single wei retained here is a wei the parties can
    /// never withdraw, because the factory has no way to move funds at all.
    function test_FactoryHoldsNoMon() public {
        uint256 clientBefore = client.balance;

        Escrow a = _newEscrow();
        Escrow b = _createEscrow(client, _params(), _oneMilestone(5 ether, Escrow.Check.Http), 5 ether);
        Escrow c = _createEscrow(client, _params(), _oneMilestone(0.5 ether, Escrow.Check.ClientApproval), 0.5 ether);

        assertEq(address(factory).balance, 0, "the factory kept nothing");

        assertEq(address(a).balance, TOTAL, "escrow a holds its own funding");
        assertEq(address(b).balance, 5 ether, "escrow b holds its own funding");
        assertEq(address(c).balance, 0.5 ether, "escrow c holds its own funding");

        assertEq(address(a).balance, a.totalAmount(), "a's balance equals the total it reports");
        assertEq(address(b).balance, b.totalAmount(), "b's balance equals the total it reports");
        assertEq(address(c).balance, c.totalAmount(), "c's balance equals the total it reports");

        uint256 sent = TOTAL + 5 ether + 0.5 ether;
        assertEq(clientBefore - client.balance, sent, "the client paid exactly the three totals");
        assertEq(
            address(a).balance + address(b).balance + address(c).balance,
            sent,
            "and every wei of it is sitting in the escrows"
        );
    }

    /*//////////////////////////////////////////////////////////////
                             INDEPENDENCE
    //////////////////////////////////////////////////////////////*/

    /// Escrows deployed by the same factory for the same two people share nothing. Paying
    /// out a milestone in one job must not move a milestone, a balance or a credit in
    /// another — the factory is an index, never a shared vault.
    function test_EscrowsAreIndependent() public {
        Escrow a = _acceptedEscrow();
        Escrow b = _acceptedEscrow();
        assertTrue(address(a) != address(b), "two distinct escrows");

        _submitAndPass(a, 0);
        vm.warp(block.timestamp + WINDOW);
        a.release(0);

        vm.prank(freelancer);
        a.withdraw();

        assertEq(uint256(_state(a, 0)), uint256(Escrow.MState.Released), "a's milestone 0 is paid");
        assertEq(a.releasedAmount(), M0, "a released exactly one milestone");
        assertEq(address(a).balance, TOTAL - M0, "a paid out of its own balance");

        assertEq(uint256(_state(b, 0)), uint256(Escrow.MState.Pending), "b's milestone 0 never moved");
        assertEq(uint256(_state(b, 1)), uint256(Escrow.MState.Pending), "b's milestone 1 never moved");
        assertEq(uint256(_state(b, 2)), uint256(Escrow.MState.Pending), "b's milestone 2 never moved");
        assertEq(b.releasedAmount(), 0, "b released nothing");
        assertEq(b.owed(freelancer), 0, "b owes the freelancer nothing");
        assertEq(address(b).balance, TOTAL, "b's funding is fully intact");

        assertEq(address(factory).balance, 0, "and the factory still holds nothing");
        assertEq(factory.escrowCountOf(freelancer), 2, "both jobs are still on the freelancer's dashboard");
    }
}
