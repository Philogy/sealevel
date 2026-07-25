// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {PlankDeployer, BuildOptions} from "plank-foundry-deployer/PlankDeployer.sol";
import {Aqua} from "aqua/src/Aqua.sol";

import {ISeaLevel} from "src/ISeaLevel.sol";

contract DeploySeaLevel is Script, PlankDeployer {
    function run() external {
        BuildOptions memory options = initBuildOptions().dependency("sea_level", "src");
        bytes memory seaLevelInitcode = plankBuildFFI("src/SeaLevel.plk", options);

        vm.startBroadcast(vm.envUint("PRIV_KEY"));
        address aqua = vm.envOr("AQUA", address(0));

        if (aqua == address(0)) {
            aqua = address(new Aqua());
            console.log("deployed aqua: %s", aqua);
        }

        address seaLevel = _deploy(bytes.concat(seaLevelInitcode, abi.encode(aqua)), 0);

        vm.stopBroadcast();

        console.log("SeaLevel: %s", seaLevel);
    }
}
