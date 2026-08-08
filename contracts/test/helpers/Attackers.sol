// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Escrow} from "../../src/Escrow.sol";

/// @notice Freelancer that tries to re-enter `withdraw()` from its `receive()` to be paid
///         twice for the same milestone.
contract ReentrantFreelancer {
    Escrow public escrow;
    uint256 public reentryAttempts;
    bool public reentrySucceeded;
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
        try escrow.withdraw() {
            reentrySucceeded = true;
        } catch {}
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
