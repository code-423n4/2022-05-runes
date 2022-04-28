// SPDX-License-Identifier: GPL-3.0

pragma solidity ^0.8.6;

import '../interfaces/IForgottenRunesWarriorsMinter.sol';

contract MaliciousWarriorBuyer {
    function bid(IForgottenRunesWarriorsMinter minter, uint256 numWarriors)
        public
        payable
    {
        minter.bidSummon{value: msg.value}(numWarriors);
    }

    receive() external payable {
        assembly {
            invalid()
        }
    }

    /**
     * @notice Conform to safe transfer protocol
     */
    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure returns (bytes4) {
        return
            bytes4(
                keccak256('onERC721Received(address,address,uint256,bytes)')
            );
    }
}
