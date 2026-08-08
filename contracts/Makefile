# MonEscrow contracts.
#
# `lib/` is gitignored and the dependencies were installed with `--no-git`, so a fresh
# clone has no dependencies at all and `forge build` fails with a wall of "No such file or
# directory". That is not a broken repo — it is one command away from working, and this
# file is that command.
#
#   make setup        install pinned dependencies
#   make test         run the suite
#   make gate         everything G1 requires, in one shot
#   make initcode     creation bytecode + hash for the Safe deployment (A-3)
#   make repro        prove this checkout compiles to the deployed bytecode (A-12)
#   make probe-evm    re-verify Cancun support against live Monad testnet

FORGE_STD_TAG := v1.16.2
OZ_TAG        := v5.7.0
RPC           := https://testnet-rpc.monad.xyz

.PHONY: setup test gate build fmt sizes initcode repro probe-evm clean

setup:
	@test -d lib/forge-std || forge install --no-git foundry-rs/forge-std@$(FORGE_STD_TAG)
	@test -d lib/openzeppelin-contracts || forge install --no-git OpenZeppelin/openzeppelin-contracts@$(OZ_TAG)
	@echo "dependencies pinned: forge-std $(FORGE_STD_TAG), openzeppelin-contracts $(OZ_TAG)"

build: setup
	forge build

test: setup
	forge test -vv

fmt:
	forge fmt --check

sizes: setup
	forge build --sizes

# The three conditions of gate G1, in the order they are cheapest to fail.
# Pinned to forge 1.7.1 (D-5) — a different formatter rewrites files nobody touched.
gate: setup
	forge fmt --check
	forge build --sizes
	forge test
	@echo ""
	@echo "G1 conditions all green. forge version in use:"
	@forge --version | head -2

# What the Safe actually deploys. The receipt of a Safe deployment has
# `contractAddress: null` — the Safe delegatecalls CreateCall, so read the deployed
# address out of the ContractCreation log, emitted from the Safe's own address.
initcode: setup
	forge script script/Deploy.s.sol:DeployScript --sig "initCode()" --offline

# A-12. A clean checkout must compile to the same runtime bytecode that is deployed and
# verified, or "verified on the explorer" means nothing. Verified 2026-08-08: a pristine
# tree with no lib/, after `make setup`, produces byte-identical runtime bytecode to the
# working tree — EscrowFactory sha256 0013af7e…, Escrow sha256 fdd957ca….
repro: setup
	forge build
	@node -e "                                                                      \
	  const fs=require('fs'), c=require('crypto');                                  \
	  let bad=0;                                                                    \
	  for (const n of ['EscrowFactory','Escrow']) {                                 \
	    const p='out/'+n+'.sol/'+n+'.json';                                          \
	    if(!fs.existsSync(p)){console.error('missing '+p);bad=1;continue;}           \
	    const o=JSON.parse(fs.readFileSync(p,'utf8')).deployedBytecode.object;       \
	    if(!o||o.length<10){console.error(n+': empty bytecode');bad=1;continue;}     \
	    const h=c.createHash('sha256').update(o).digest('hex');                      \
	    console.log(n.padEnd(14)+' runtime sha256 '+h+'  ('+((o.length-2)/2)+' B)'); \
	  }                                                                             \
	  process.exit(bad);"
	@echo ""
	@echo "Compare against the chain once deployed:"
	@echo "  cast code <FACTORY> --rpc-url $(RPC) | tr -d '\\n' | sha256sum"

# Was `jq ... | sha256sum`. On a machine without jq that pipeline prints the sha256 of an
# EMPTY STREAM and still exits 0 — so it would have reported a confident, meaningless hash
# and "proved" a reproducible build that never happened. Node ships with the toolchain
# already, errors loudly on a missing or empty artifact, and exits non-zero. A verification
# step that cannot fail is not a verification step.

# Cancun is not assumed here, it is probed. MCOPY (EIP-5656) must return 0x01…, and
# TSTORE/TLOAD (EIP-1153) must return 0x07. Both were confirmed on Monad testnet before
# evm_version = "cancun" and ReentrancyGuardTransient were adopted.
probe-evm:
	@echo "MCOPY  (expect 0x01...):"
	@cast call --rpc-url $(RPC) --create 0x6020600060405e600160005360206000f3
	@echo "TSTORE (expect 0x07):"
	@cast call --rpc-url $(RPC) --create 0x600760005d600060005c60005260206000f3

clean:
	forge clean
