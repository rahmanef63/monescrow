// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {EscrowFactory} from "../src/EscrowFactory.sol";

/// @title DeployScript
/// @notice Deploys `EscrowFactory` to Monad testnet.
///
/// @dev **This script is not how the factory actually reaches the chain.** The deployment
///      is executed by a 2-of-2 Safe, which delegatecalls `CreateCall` rather than
///      broadcasting from an EOA. So the script has two jobs, and the second one is the
///      one that matters:
///
///      1. `run()` — a normal broadcast deploy, used against local anvil so the frontend
///         has something to build against before G2.
///      2. `initCode()` — prints the exact creation bytecode the Safe must pass to
///         `CreateCall.performCreate`. This is the artifact A-3 consumes.
///
///      Dry-run against the Safe as sender before proposing anything:
///
///          forge script script/Deploy.s.sol:DeployScript --sig "initCode()" \
///              --rpc-url monad_testnet --sender $SAFE
///
///      `EscrowFactory` takes no constructor arguments, so its creation code is its
///      `type(...).creationCode` with nothing appended. That is worth stating explicitly
///      because it is the one case where forgetting to ABI-encode arguments still
///      produces a contract — one that is subtly wrong rather than obviously broken.
contract DeployScript is Script {
    function run() external returns (EscrowFactory factory) {
        vm.startBroadcast();
        factory = new EscrowFactory();
        vm.stopBroadcast();

        console2.log("EscrowFactory deployed at:", address(factory));
        console2.log("chainid:", block.chainid);
    }

    /// @notice Print the creation bytecode for the Safe to deploy, plus its hash.
    /// @dev The hash exists so the value pasted into the Safe proposal can be checked
    ///      against the value produced here. A truncated copy-paste is otherwise very
    ///      hard to notice and very expensive to debug after the fact.
    function initCode() external pure returns (bytes memory code) {
        code = type(EscrowFactory).creationCode;
        console2.log("EscrowFactory creation code length (bytes):", code.length);
        console2.logBytes32(keccak256(code));
    }

    /// @notice Runtime bytecode hash of what *should* end up on chain.
    /// @dev A-12 (reproducible build) compares this against `eth_getCode` at the deployed
    ///      address. They will differ in the trailing CBOR metadata unless the verifier
    ///      compiles the identical source with the identical settings — which is the
    ///      point of pinning solc 0.8.28 and forge 1.7.1 (D-5).
    function runtimeHash() external pure returns (bytes32) {
        return keccak256(type(EscrowFactory).runtimeCode);
    }
}
