// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/// @author philogy <https://github.com/philogy>
interface ISeaLevel {
    function swap(address maker, address tokenIn, address tokenOut, uint16 feeRate, uint256 amountIn) external;

    function setup_token(address token) external;
}
