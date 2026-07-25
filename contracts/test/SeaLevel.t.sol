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
    ExampleStablecoin internal eurc;
    ExampleStablecoin internal eurt;

    function setUp() public {
        aqua = new Aqua();

        BuildOptions memory options = initBuildOptions().dependency("sea_level", "src");
        bytes memory initcode = plankBuildFFI("src/SeaLevel.plk", options);
        seaLevel = ISeaLevel(_deploy(bytes.concat(initcode, abi.encode(address(aqua))), 0));

        usdc = new ExampleStablecoin("USD Coin", "USDC", 6);
        usdt = new ExampleStablecoin("Tether USD", "USDT", 6);
        dai = new ExampleStablecoin("Dai Stablecoin", "DAI", 18);
        eurc = new ExampleStablecoin("Euro Coin", "EURC", 6);
        eurt = new ExampleStablecoin("Tether EUR", "EURT", 6);

        _fundAndApprove(usdc, 10_000_000e6, 1_000_000e6);
        _fundAndApprove(usdt, 10_000_000e6, 1_000_000e6);
        _fundAndApprove(dai, 10_000_000e18, 1_000_000e18);
        _fundAndApprove(eurc, 10_000_000e6, 1_000_000e6);
        _fundAndApprove(eurt, 10_000_000e6, 1_000_000e6);
    }

    function test_deploymentAndTokenSetup() public view {
        assertGt(address(seaLevel).code.length, 0);
        assertEq(usdc.allowance(address(seaLevel), address(aqua)), type(uint256).max);
        assertEq(usdt.allowance(address(seaLevel), address(aqua)), type(uint256).max);
        assertEq(dai.allowance(address(seaLevel), address(aqua)), type(uint256).max);
        assertEq(eurc.allowance(address(seaLevel), address(aqua)), type(uint256).max);
        assertEq(eurt.allowance(address(seaLevel), address(aqua)), type(uint256).max);
    }

    function test_swapStablecoinsWithSameDecimals() public {
        (bytes memory strategy, bytes32 strategyHash) = _ship(usdc, usdt, 5_000_000e6, 5_000_000e6);
        uint256 amountIn = 1_000e6;
        uint256 expectedOut = 997e6;

        uint256 makerInBefore = usdc.balanceOf(MAKER);
        uint256 makerOutBefore = usdt.balanceOf(MAKER);
        uint256 takerOutBefore = usdt.balanceOf(TAKER);

        vm.prank(TAKER);
        seaLevel.swap(strategy, 0, 1, MAKER, amountIn);

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
        (bytes memory strategy, bytes32 strategyHash) = _ship(usdc, dai, 5_000_000e6, 5_000_000e18);

        uint256 daiIn = 400e18;
        uint256 expectedUsdcOut = 398_800_000;
        vm.prank(TAKER);
        seaLevel.swap(strategy, 1, 0, MAKER, daiIn);

        assertEq(dai.balanceOf(TAKER), 1_000_000e18 - daiIn);
        assertEq(usdc.balanceOf(TAKER), 1_000_000e6 + expectedUsdcOut);

        uint256 usdcIn = 250e6;
        uint256 expectedDaiOut = 249_250_000_000_000_000_000;
        vm.prank(TAKER);
        seaLevel.swap(strategy, 0, 1, MAKER, usdcIn);

        assertEq(usdc.balanceOf(TAKER), 1_000_000e6 + expectedUsdcOut - usdcIn);
        assertEq(dai.balanceOf(TAKER), 1_000_000e18 - daiIn + expectedDaiOut);

        (uint248 usdcBalance,) = aqua.rawBalances(MAKER, address(seaLevel), strategyHash, address(usdc));
        (uint248 daiBalance,) = aqua.rawBalances(MAKER, address(seaLevel), strategyHash, address(dai));
        assertEq(usdcBalance, 5_000_000e6 - expectedUsdcOut + usdcIn);
        assertEq(daiBalance, 5_000_000e18 + daiIn - expectedDaiOut);
    }

    function test_sameFeeTokenSetsHaveIndependentStrategies() public {
        (bytes memory usdStrategy, bytes32 usdStrategyHash) = _ship(usdc, usdt, 5_000_000e6, 5_000_000e6);
        (bytes memory eurStrategy, bytes32 eurStrategyHash) = _ship(eurc, eurt, 4_000_000e6, 4_000_000e6);

        assertEq(usdStrategyHash, keccak256(abi.encodePacked(FEE_BPS, address(usdc), address(usdt))));
        assertEq(eurStrategyHash, keccak256(abi.encodePacked(FEE_BPS, address(eurc), address(eurt))));
        assertNotEq(usdStrategyHash, eurStrategyHash);

        vm.startPrank(TAKER);
        seaLevel.swap(usdStrategy, 0, 1, MAKER, 100e6);
        seaLevel.swap(eurStrategy, 0, 1, MAKER, 200e6);
        vm.stopPrank();

        (uint248 usdIn,) = aqua.rawBalances(MAKER, address(seaLevel), usdStrategyHash, address(usdc));
        (uint248 usdOut,) = aqua.rawBalances(MAKER, address(seaLevel), usdStrategyHash, address(usdt));
        (uint248 eurIn,) = aqua.rawBalances(MAKER, address(seaLevel), eurStrategyHash, address(eurc));
        (uint248 eurOut,) = aqua.rawBalances(MAKER, address(seaLevel), eurStrategyHash, address(eurt));

        assertEq(usdIn, 5_000_100e6);
        assertEq(usdOut, 4_999_900_300_000);
        assertEq(eurIn, 4_000_200e6);
        assertEq(eurOut, 3_999_800_600_000);

        (uint248 eurcInUsdStrategy, uint8 eurcInUsdTokenCount) =
            aqua.rawBalances(MAKER, address(seaLevel), usdStrategyHash, address(eurc));
        (uint248 usdcInEurStrategy, uint8 usdcInEurTokenCount) =
            aqua.rawBalances(MAKER, address(seaLevel), eurStrategyHash, address(usdc));
        assertEq(eurcInUsdStrategy, 0);
        assertEq(eurcInUsdTokenCount, 0);
        assertEq(usdcInEurStrategy, 0);
        assertEq(usdcInEurTokenCount, 0);
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
        returns (bytes memory strategy, bytes32 strategyHash)
    {
        strategy = abi.encodePacked(FEE_BPS, address(token0), address(token1));

        address[] memory tokens = new address[](2);
        tokens[0] = address(token0);
        tokens[1] = address(token1);

        uint256[] memory amounts = new uint256[](2);
        amounts[0] = amount0;
        amounts[1] = amount1;

        vm.prank(MAKER);
        strategyHash = aqua.ship(address(seaLevel), strategy, tokens, amounts);
    }
}
