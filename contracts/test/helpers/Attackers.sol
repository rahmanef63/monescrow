// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Escrow} from "../../src/Escrow.sol";

/// @notice Freelancer that tries to re-enter `withdraw()` from its `receive()` to be paid
///         twice for the same milestone.
/// @dev The callback does not just note that the nested call failed — it records *why*, so a
///      test can tell the two independent defences apart. `owedAtReentry` is the caller's
///      credit as the escrow sees it mid-transfer, which proves whether the effect really
///      landed before the interaction; `reentryRevertData` is the raw return data of the
///      nested call, which names whichever error rejected it. A `try/catch` would throw that
///      data away, so the nested call is made with a low-level `call`.
contract ReentrantFreelancer {
    Escrow public escrow;
    uint256 public reentryAttempts;
    bool public reentrySucceeded;
    /// @notice `owed[this]` read from inside the callback, i.e. while the outer transfer runs.
    uint256 public owedAtReentry;
    /// @notice Raw return data of the nested `withdraw()` — empty if it somehow succeeded.
    bytes public reentryRevertData;
    bool internal armed;

    function setEscrow(Escrow e) external {
        escrow = e;
    }

    function doAccept() external {
        escrow.accept();
    }

    function doSubmit(uint256 i, bytes32 evidence) external {
        escrow.submit(i, evidence);
    }

    function attackWithdraw() external {
        armed = true;
        escrow.withdraw();
        armed = false;
    }

    receive() external payable {
        if (!armed) return;
        reentryAttempts++;

        // Read the credit BEFORE re-entering: this is what the escrow believes it still owes
        // us while it is in the middle of paying us.
        owedAtReentry = escrow.owed(address(this));

        (bool ok, bytes memory ret) = address(escrow).call(abi.encodeCall(Escrow.withdraw, ()));
        reentrySucceeded = ok;
        reentryRevertData = ret;
    }
}

/// @notice Freelancer whose `receive()` always reverts — used to prove a failed transfer
///         surfaces as a revert instead of silently zeroing the balance.
contract RejectingFreelancer {
    Escrow public escrow;

    function setEscrow(Escrow e) external {
        escrow = e;
    }

    function doAccept() external {
        escrow.accept();
    }

    function doSubmit(uint256 i, bytes32 evidence) external {
        escrow.submit(i, evidence);
    }

    function doWithdraw() external {
        escrow.withdraw();
    }

    receive() external payable {
        revert("no thanks");
    }
}
