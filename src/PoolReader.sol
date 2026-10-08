// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IFWAV2 {
    function slotToListing(uint256 slot) external view returns (uint256);
    function listings(uint256 id) external view returns (
        address, address, address, uint256, uint256 weight, uint256 value,
        uint256, uint256, uint256, uint64, uint8 status);
}

/// Never deployed. Sent as the init code of an eth_call (no `to`). The constructor walks
/// slots [fromSlot, toSlot) of the FWAV2 pool and REVERTS with
///     MAGIC ‖ word[0] ‖ word[1] ‖ …
/// one word per Active listing: id (32 bits) | value (96 bits) | weight (128 bits).
/// Revert data is used because returned init-code output is capped at 24 KB (EIP-170).
contract PoolReader {
    bytes32 constant MAGIC = "FWAPOOL1";

    constructor(IFWAV2 fwa, uint256 fromSlot, uint256 toSlot) {
        uint256 n = toSlot - fromSlot;
        bytes memory out = new bytes(32 + n * 32);
        uint256 k;
        for (uint256 s = fromSlot; s < toSlot; ++s) {
            uint256 id = fwa.slotToListing(s);
            if (id == 0) continue;
            (,,,, uint256 w, uint256 v,,,,, uint8 st) = fwa.listings(id);
            if (st != 1) continue;
            require(id < 2**32 && v < 2**96 && w < 2**128, "pack overflow");
            uint256 word = (id << 224) | (v << 128) | w;
            assembly { mstore(add(out, add(64, mul(k, 32))), word) }
            ++k;
        }
        bytes32 magic = MAGIC;
        assembly {
            mstore(add(out, 32), magic)
            revert(add(out, 32), add(32, mul(k, 32)))
        }
    }
}
