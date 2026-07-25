// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {PlankDeployer, BuildOptions} from "plank-foundry-deployer/PlankDeployer.sol";
import {Aqua} from "aqua/src/Aqua.sol";

import {ISeaLevel} from "src/ISeaLevel.sol";

contract DeploySeaLevel is Script, PlankDeployer {
    function run() external returns (Aqua aqua, ISeaLevel seaLevel) {
        BuildOptions memory options = initBuildOptions().dependency("sea_level", "src");
        bytes memory seaLevelInitcode = plankBuildFFI("src/SeaLevel.plk", options);

        vm.startBroadcast(vm.envUint("PRIV_KEY"));

        aqua = new Aqua();
        seaLevel = ISeaLevel(_deploy(bytes.concat(seaLevelInitcode, abi.encode(address(aqua))), 0));

        vm.stopBroadcast();

        console2.log("Aqua:", address(aqua));
        console2.log("SeaLevel:", address(seaLevel));
    }
}
