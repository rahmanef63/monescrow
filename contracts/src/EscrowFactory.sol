// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Escrow} from "./Escrow.sol";

/// @title EscrowFactory
/// @notice Deploys funded `Escrow` agreements and keeps enough onchain index for a
///         frontend to list them with plain `eth_call`s — no indexer, no backend.
/// @dev The factory holds no funds and has no owner, admin or moderation role. It never
///      takes a fee and cannot touch an escrow once created.
///
///      Testnet demo contract. NOT AUDITED. Do not use with real funds.
contract EscrowFactory {
    /// @notice Every escrow ever deployed, in creation order.
    address[] public escrows;

    /// @notice True if the address came out of this factory.
    mapping(address escrow => bool created) public isEscrow;

    /// @notice Escrows where the address is the client or the freelancer.
    mapping(address party => address[] escrows) private _byParty;

    event EscrowCreated(
        address indexed escrow,
        address indexed client,
        address indexed freelancer,
        uint256 totalAmount,
        uint256 milestoneCount,
        uint256 index
    );

    error BadRange();

    /// @notice Create and fund an escrow in one transaction.
    /// @dev `msg.sender` is the client — it is never taken from calldata. The full amount
    ///      is forwarded, so the money is in place before the freelancer is asked to
    ///      accept; there is no "funded later" state for either side to worry about.
    function createEscrow(Escrow.Params calldata p, Escrow.MilestoneInit[] calldata ms)
        external
        payable
        returns (address escrow)
    {
        // All argument validation lives in the Escrow constructor — one source of truth.
        escrow = address(new Escrow{value: msg.value}(msg.sender, p, ms));

        uint256 index = escrows.length;
        escrows.push(escrow);
        isEscrow[escrow] = true;
        _byParty[msg.sender].push(escrow);
        _byParty[p.freelancer].push(escrow);

        emit EscrowCreated(escrow, msg.sender, p.freelancer, msg.value, ms.length, index);
    }

    function escrowCount() external view returns (uint256) {
        return escrows.length;
    }

    function getEscrows() external view returns (address[] memory) {
        return escrows;
    }

    /// @notice A slice of the escrow array, oldest-first.
    function getEscrows(uint256 offset, uint256 limit) external view returns (address[] memory page) {
        uint256 total = escrows.length;
        if (offset > total) revert BadRange();

        uint256 end = offset + limit;
        if (end > total) end = total;

        page = new address[](end - offset);
        for (uint256 i = offset; i < end; ++i) {
            page[i - offset] = escrows[i];
        }
    }

    /// @notice Every escrow `party` is involved in, as client or as freelancer.
    function escrowsOf(address party) external view returns (address[] memory) {
        return _byParty[party];
    }

    function escrowCountOf(address party) external view returns (uint256) {
        return _byParty[party].length;
    }
}
