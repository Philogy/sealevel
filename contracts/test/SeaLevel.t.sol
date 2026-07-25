// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {PlankDeployer, BuildOptions} from "plank-foundry-deployer/PlankDeployer.sol";
import {Aqua} from "aqua/src/Aqua.sol";
import {IAqua} from "aqua/src/interfaces/IAqua.sol";

import {ISeaLevel} from "src/ISeaLevel.sol";
import {ExampleStablecoin} from "test/mocks/ExampleStablecoin.sol";

contract SeaLevelTest is Test, PlankDeployer {
    uint16 internal constant FEE_BPS = 30;
    address internal constant MAKER = address(0xA11CE);
    address internal constant TAKER = address(0xB0B);

    IAqua internal aqua;
    ISeaLevel internal seaLevel;
    ExampleStablecoin internal usdc;
    ExampleStablecoin internal usdt;
    ExampleStablecoin internal dai;

    function setUp() public {
        aqua = new Aqua();

        BuildOptions memory options = initBuildOptions().dependency("sea_level", "src");
        bytes memory initcode = plankBuildFFI("src/SeaLevel.plk", options);
        seaLevel = ISeaLevel(_deploy(bytes.concat(initcode, abi.encode(address(aqua))), 0));

        usdc = new ExampleStablecoin("USD Coin", "USDC", 6);
        usdt = new ExampleStablecoin("Tether USD", "USDT", 6);
        dai = new ExampleStablecoin("Dai Stablecoin", "DAI", 18);

        _fundAndApprove(usdc, 10_000_000e6, 1_000_000e6);
        _fundAndApprove(usdt, 10_000_000e6, 1_000_000e6);
        _fundAndApprove(dai, 10_000_000e18, 1_000_000e18);
    }

    function test_deploymentAndTokenSetup() public view {
        assertGt(address(seaLevel).code.length, 0);
        assertEq(usdc.allowance(address(seaLevel), address(aqua)), type(uint256).max);
        assertEq(usdt.allowance(address(seaLevel), address(aqua)), type(uint256).max);
        assertEq(dai.allowance(address(seaLevel), address(aqua)), type(uint256).max);
    }

    function test_swapStablecoinsWithSameDecimals() public {
        bytes32 strategyHash = _ship(usdc, usdt, 5_000_000e6, 5_000_000e6);
        uint256 amountIn = 1_000e6;
        uint256 expectedOut = 997e6;

        uint256 makerInBefore = usdc.balanceOf(MAKER);
        uint256 makerOutBefore = usdt.balanceOf(MAKER);
        uint256 takerOutBefore = usdt.balanceOf(TAKER);

        vm.prank(TAKER);
        seaLevel.swap(MAKER, address(usdc), address(usdt), FEE_BPS, amountIn);

        assertEq(usdc.balanceOf(TAKER), 1_000_000e6 - amountIn);
        assertEq(usdc.balanceOf(MAKER), makerInBefore + amountIn);
        assertEq(usdt.balanceOf(MAKER), makerOutBefore - expectedOut);
        assertEq(usdt.balanceOf(TAKER), takerOutBefore + expectedOut);

        (uint248 inBalance,) = aqua.rawBalances(MAKER, address(seaLevel), strategyHash, address(usdc));
        (uint248 outBalance,) = aqua.rawBalances(MAKER, address(seaLevel), strategyHash, address(usdt));
        assertEq(inBalance, 5_000_000e6 + amountIn);
        assertEq(outBalance, 5_000_000e6 - expectedOut);
    }

    function test_bidirectionalSwapsBetweenSixAndEighteenDecimals() public {
        bytes32 strategyHash = _ship(usdc, dai, 5_000_000e6, 5_000_000e18);

        uint256 daiIn = 400e18;
        uint256 expectedUsdcOut = 398_800_000;
        vm.prank(TAKER);
        seaLevel.swap(MAKER, address(dai), address(usdc), FEE_BPS, daiIn);

        assertEq(dai.balanceOf(TAKER), 1_000_000e18 - daiIn);
        assertEq(usdc.balanceOf(TAKER), 1_000_000e6 + expectedUsdcOut);

        uint256 usdcIn = 250e6;
        uint256 expectedDaiOut = 249_250_000_000_000_000_000;
        vm.prank(TAKER);
        seaLevel.swap(MAKER, address(usdc), address(dai), FEE_BPS, usdcIn);

        assertEq(usdc.balanceOf(TAKER), 1_000_000e6 + expectedUsdcOut - usdcIn);
        assertEq(dai.balanceOf(TAKER), 1_000_000e18 - daiIn + expectedDaiOut);

        (uint248 usdcBalance,) = aqua.rawBalances(MAKER, address(seaLevel), strategyHash, address(usdc));
        (uint248 daiBalance,) = aqua.rawBalances(MAKER, address(seaLevel), strategyHash, address(dai));
        assertEq(usdcBalance, 5_000_000e6 - expectedUsdcOut + usdcIn);
        assertEq(daiBalance, 5_000_000e18 + daiIn - expectedDaiOut);
    }

    function _fundAndApprove(ExampleStablecoin token, uint256 makerAmount, uint256 takerAmount) internal {
        token.mint(MAKER, makerAmount);
        token.mint(TAKER, takerAmount);

        vm.prank(MAKER);
        token.approve(address(aqua), type(uint256).max);
        vm.prank(TAKER);
        token.approve(address(seaLevel), type(uint256).max);
        seaLevel.setup_token(address(token));
    }

    function _ship(ExampleStablecoin token0, ExampleStablecoin token1, uint256 amount0, uint256 amount1)
        internal
        returns (bytes32 strategyHash)
    {
        address[] memory tokens = new address[](2);
        tokens[0] = address(token0);
        tokens[1] = address(token1);

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = amount0;
        amounts[1] = amount1;

        vm.prank(MAKER);
        strategyHash = aqua.ship(address(seaLevel), abi.encode(FEE_BPS), tokens, amounts);
    }
}
