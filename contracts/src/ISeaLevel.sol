// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @author philogy <https://github.com/philogy>
interface ISeaLevel {
    function swap(bytes calldata strategy, uint256 tokenInIndex, uint256 tokenOutIndex, address maker, uint256 amountIn)
        external;

    function setup_token(address token) external;
}
