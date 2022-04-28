// SPDX-License-Identifier: GPL-3.0

/// @title Interface for ForgottenRunesWarriorsMinter

pragma solidity ^0.8.6;

interface IForgottenRunesWarriorsMinter {
    function bidSummon(uint256 numWarriors) external payable;
}
