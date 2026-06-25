// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC721Minimal {
    function transferFrom(address from, address to, uint256 tokenId) external;
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title GregBurner
/// @notice Lets a Greg holder burn many tokens (send to the dead address) in a single transaction.
///         Emits one event per batch so an off-chain dashboard can pick it up and notify the team.
contract GregBurner {
    /// @dev Standard, widely-recognized "dead" burn address. No private key exists for it.
    // Written all-lowercase so Solidity does not attempt EIP-55 checksum
    // validation on this literal (it only checks mixed-case hex literals).
    // This is the same address as the commonly-seen "...dEaD" form.
    address public constant DEAD_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice The Greg NFT contract this burner is wired to.
    IERC721Minimal public immutable gregContract;

    /// @notice Hard cap per call so a batch can't exceed block gas limits.
    /// Covers the top tier: 100 Gregs for a commissioned Greg.
    uint256 public constant MAX_BATCH_SIZE = 100;

    /// @notice Emitted once per burnMany call — this is what the dashboard listens for.
    event GregsBurned(address indexed burner, uint256[] tokenIds, uint256 timestamp);

    error EmptyBatch();
    error BatchTooLarge();
    error NotApproved();
    error NotOwner(uint256 tokenId);

    constructor(address _gregContract) {
        gregContract = IERC721Minimal(_gregContract);
    }

    /// @notice Burns (sends to the dead address) every tokenId passed in, all owned by the caller.
    /// @dev Caller must have called setApprovalForAll(address(this), true) on the Greg contract first.
    function burnMany(uint256[] calldata tokenIds) external {
        uint256 len = tokenIds.length;
        if (len == 0) revert EmptyBatch();
        if (len > MAX_BATCH_SIZE) revert BatchTooLarge();
        if (!gregContract.isApprovedForAll(msg.sender, address(this))) revert NotApproved();

        for (uint256 i = 0; i < len; i++) {
            uint256 tokenId = tokenIds[i];
            if (gregContract.ownerOf(tokenId) != msg.sender) revert NotOwner(tokenId);
            gregContract.transferFrom(msg.sender, DEAD_ADDRESS, tokenId);
        }

        emit GregsBurned(msg.sender, tokenIds, block.timestamp);
    }
}
