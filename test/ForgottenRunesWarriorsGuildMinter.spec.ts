import { AddressZero } from '@ethersproject/constants';
import { parseEther } from '@ethersproject/units';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import chai from 'chai';
import { solidity } from 'ethereum-waffle';
import { BigNumber, Contract, Wallet } from 'ethers';
import { solidityKeccak256 } from 'ethers/lib/utils';
import { ethers, waffle } from 'hardhat';
import keccak256 from 'keccak256';
import { MerkleTree } from 'merkletreejs';
import { printGasEstimate } from './utils';

chai.use(solidity);
const { expect } = chai;

let gwei = '70';

const makeMintlistMerkles = (collectors: string[]) => {
  const elements = collectors.map((x) => solidityKeccak256(['address'], [x]));
  const merkleTree = new MerkleTree(elements, keccak256, { sort: true });
  return { merkleTree, elements };
};

export const deployWeth = async (
  deployer?: SignerWithAddress
): Promise<Contract> => {
  const factory = await ethers.getContractFactory('WETH', deployer);
  let weth = await factory.deploy();
  await weth.deployed();
  return weth;
};

export async function setupWarriorsContext({ provider }) {
  const signers = await ethers.getSigners();
  const wallet = signers[0];
  let alice = signers[1];
  let bob = signers[2];
  let eve = signers[3];

  let warriorsContract: Contract;
  {
    const contractFactory = await ethers.getContractFactory(
      'ForgottenRunesWarriorsGuild',
      signers[0]
    );
    warriorsContract = await contractFactory.deploy('https://foo.bar/');
  }

  let weth = await deployWeth(wallet);

  return {
    warriorsContract,
    weth,
  };
}

const createFundedWallet = async (provider, from, value) => {
  let _wallet = Wallet.createRandom();
  _wallet = _wallet.connect(await provider);
  const txResponse = await from.sendTransaction({
    to: _wallet.address,
    value,
  });
  await provider.waitForTransaction(txResponse.hash);
  return _wallet;
};

/**
 * Because this auction is in phases, we need to mint out the DA more than once,
 * so we put it in this function here. It takes a while to run.
 */
const mintAllInDutchAuction = async ({
  contract,
  warriorsContract,
  alice,
  bob,
  carol,
  now,
  price,
}) => {
  await bob.sendTransaction({
    to: alice.address,
    value: parseEther('9999'),
  });
  await carol.sendTransaction({
    to: alice.address,
    value: parseEther('9999'),
  });

  const daPriceCurveLength = await contract.daPriceCurveLength();
  await contract.setPhaseTimes(
    now - daPriceCurveLength.toNumber(), // lowest price
    now + 60 * 60 * 1,
    now + 60 * 60 * 2,
    now + 60 * 60 * 3
  );
  const maxDaSupply = await contract.maxDaSupply();
  expect(maxDaSupply).to.eq(8000);
  expect(await contract.finalPrice()).to.eq(parseEther('2.5'));

  contract = contract.connect(alice);
  warriorsContract = warriorsContract.connect(alice);

  console.log('minting all...');
  for (let i = 0; i < maxDaSupply / 20 - 1; i++) {
    const tx = contract.bidSummon(20, { value: price.mul(20) });
    await expect(tx)
      .to.emit(warriorsContract, 'Transfer')
      .withArgs(AddressZero, alice.address, i * 20);
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`minting: ${i}/${maxDaSupply / 20}`);
  }
  process.stdout.write('\n');

  {
    // buy right up to the edge
    const tx = contract.bidSummon(18, { value: price.mul(18) });
    await expect(tx)
      .to.emit(warriorsContract, 'Transfer')
      .withArgs(AddressZero, alice.address, 7997);
  }

  {
    // even though there are some remaining, don't buy more than are left
    expect(await contract.numSold()).to.eq(7998);
    const tx = contract.bidSummon(3, { value: price.mul(3) });
    await expect(tx).to.be.revertedWith('Not enough remaining');
  }

  // we haven't set a new final price yet
  expect(await contract.finalPrice()).to.eq(parseEther('2.5'));

  // console.log('final price:', formatEther(await contract.finalPrice()));

  {
    // buy the last two
    const tx = contract.bidSummon(2, { value: price.mul(2) });
    await expect(tx)
      .to.emit(warriorsContract, 'Transfer')
      .withArgs(AddressZero, alice.address, 7999);
  }

  {
    expect(await contract.numSold()).to.eq(8000);
    const tx = contract.bidSummon(1, { value: price.mul(1) });
    await expect(tx).to.be.revertedWith('Auction sold out');
  }

  // should set the final price
  expect(await contract.finalPrice()).to.eq(parseEther('0.6'));
};

describe('ForgottenRunesWarriorsGuildMinter', () => {
  let wallet: SignerWithAddress;
  let alice: any;
  let bob: any;
  let carol: any;
  let eve: any;
  let vault: any;
  const provider = waffle.provider;
  let contract: Contract;
  let warriorsContract: Contract;
  let weth: Contract;
  let maliciousBuyer: Contract;
  let as: any;
  let mintlist1MerkleTree, mintlist2MerkleTree, claimlistMerkleTree;
  let snapshot;

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    wallet = signers[0];
    alice = signers[1];
    bob = signers[2];
    eve = signers[3];
    carol = signers[4];

    ({ warriorsContract, weth } = await setupWarriorsContext({
      provider,
    }));
    // await ethers.provider.send('evm_mine', []);
    // const block = await ethers.provider.getBlockNumber();
    const contractFactory = await ethers.getContractFactory(
      'ForgottenRunesWarriorsMinter',
      signers[0]
    );
    contract = await contractFactory.deploy(
      warriorsContract.address,
      weth.address
    );
    await contract.deployed();

    as = async (who) => {
      contract = contract.connect(who);
      warriorsContract = warriorsContract.connect(who);
      weth = weth.connect(who);
    };

    let { merkleTree } = makeMintlistMerkles([alice.address, bob.address]);
    mintlist1MerkleTree = merkleTree;
    mintlist2MerkleTree = merkleTree;
    claimlistMerkleTree = merkleTree;

    await warriorsContract.initialize(contract.address);
  });

  describe('during the DA', () => {
    let price, now;
    beforeEach(async () => {
      price = await contract.currentDaPrice();
      now = (await provider.getBlock(await provider.getBlockNumber()))
        .timestamp;

      await contract.setPhaseTimes(
        now - 1, // e.g. just started
        now + 60 * 60 * 1,
        now + 60 * 60 * 2,
        now + 60 * 60 * 3
      );
    });

    it('should allow the team to mint the first one', async () => {
      await expect(contract.teamSummon(wallet.address, 1))
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, wallet.address, 0);
    });
    it('should record how much was bid when you buy one', async () => {
      as(alice);
      const tx = contract.bidSummon(1, { value: price });
      await expect(tx)
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, alice.address, 0);
      expect(await contract.daAmountPaid(alice.address)).to.eq(price);
      expect(await contract.daNumMinted(alice.address)).to.eq(1);
      expect(await contract.numSold()).to.eq(1);
    });
    it('should record how much was bid when you buy multiple', async () => {
      as(alice);
      const tx = contract.bidSummon(3, { value: price.mul(3) });
      await expect(tx)
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, alice.address, 0);
      await expect(tx)
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, alice.address, 1);
      await expect(tx)
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, alice.address, 2);

      expect(await contract.daAmountPaid(alice.address)).to.eq(price.mul(3));
      expect(await contract.daNumMinted(alice.address)).to.eq(3);
      expect(await contract.numSold()).to.eq(3);
    });
    it('should record how much was bid when you buy multiple times', async () => {
      as(alice);
      const tx1 = contract.bidSummon(1, { value: price.mul(1) });
      await expect(tx1)
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, alice.address, 0);

      const tx2 = contract.bidSummon(2, { value: price.mul(2) });
      await expect(tx2)
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, alice.address, 1);
      await expect(tx2)
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, alice.address, 2);

      expect(await contract.daAmountPaid(alice.address)).to.eq(price.mul(3));
      expect(await contract.daNumMinted(alice.address)).to.eq(3);
      expect(await contract.numSold()).to.eq(3);
    });
    it('not bid before it started', async () => {
      await contract.setPhaseTimes(
        now + 60 * 60 * 1,
        now + 60 * 60 * 1,
        now + 60 * 60 * 2,
        now + 60 * 60 * 3
      );

      const tx = contract.bidSummon(1, { value: price });
      await expect(tx).to.be.revertedWith('Auction not started');
    });
    it('not bid when paused', async () => {
      await contract.pause();
      const tx = contract.bidSummon(1, { value: price });
      await expect(tx).to.be.revertedWith('Pausable: paused');
    });
    it('not bid if mintlist started', async () => {
      await contract.setPhaseTimes(
        now - 60 * 60 * 2,
        now - 60 * 60 * 1,
        now + 60 * 60 * 2,
        now + 60 * 60 * 3
      );

      const tx = contract.bidSummon(1, { value: price });
      await expect(tx).to.be.revertedWith('Auction phase over');
    });
    it('not bid 0 warriors', async () => {
      const tx = contract.bidSummon(0, { value: price });
      await expect(tx).to.be.revertedWith(
        'You can summon no more than 20 Warriors at a time'
      );
    });
    it('not bid more than 20 warriors', async () => {
      const tx = contract.bidSummon(21, { value: price.mul(21) });
      await expect(tx).to.be.revertedWith(
        'You can summon no more than 20 Warriors at a time'
      );
    });
    it('not bid if price is insufficient', async () => {
      const tx = contract.bidSummon(2, { value: price });
      await expect(tx).to.be.revertedWith('Ether value sent is not sufficient');
      const tx2 = contract.bidSummon(1, { value: 1 });
      await expect(tx2).to.be.revertedWith(
        'Ether value sent is not sufficient'
      );
    });

    describe('when minting out', () => {
      it.skip('should not allow bidding after sold out', async () => {
        await mintAllInDutchAuction({
          contract,
          warriorsContract,
          alice,
          bob,
          carol,
          now,
          price,
        });
      }).timeout(60000 * 20);
      it('should keep the highest price if mints quickly');
      it('should set the lowest price if mints slowly');
    });
    describe('when calculating prices', () => {
      let snapshot;
      beforeEach(async () => {
        snapshot = await provider.send('evm_snapshot', []);
      });
      afterEach(async () => {
        if (snapshot) {
          await provider.send('evm_revert', [snapshot]);
        }
      });

      it('should have the starting price', async () => {
        await contract.setPhaseTimes(
          now,
          now + 60 * 60 * 1,
          now + 60 * 60 * 2,
          now + 60 * 60 * 3
        );
        expect(await contract.currentDaPrice()).to.eq(parseEther('2.5'));
      });
      it('should have the final ending price', async () => {
        const daPriceCurveLength = await contract.daPriceCurveLength();
        await contract.setPhaseTimes(
          now - daPriceCurveLength.toNumber() - 15,
          now + 60 * 60 * 1,
          now + 60 * 60 * 2,
          now + 60 * 60 * 3
        );
        expect(await contract.currentDaPrice()).to.eq(parseEther('0.6'));

        await ethers.provider.send('evm_increaseTime', [60 * 60 * 1]); // Add 1 hour
        expect(await contract.currentDaPrice()).to.eq(parseEther('0.6'));
      });

      it('should have midway prices', async () => {
        const now = (await provider.getBlock(await provider.getBlockNumber()))
          .timestamp;
        await contract.setPhaseTimes(
          now,
          now + 60 * 60 * 24 * 1,
          now + 60 * 60 * 24 * 2,
          now + 60 * 60 * 24 * 3
        );
        expect(await contract.currentDaPrice()).to.eq(parseEther('2.5'));
        await provider.send('evm_increaseTime', [1]);
        await provider.send('evm_mine', []);

        let numSteps = 38; // (380 minutes / 10 minutes)
        for (let i = 0; i < numSteps; i++) {
          const currentPrice = await contract.currentDaPrice();
          expect(currentPrice).to.eq(
            ethers.utils.parseEther('2.5').sub(parseEther('0.05').mul(i))
          );
          // console.log('currentPrice: ', ethers.utils.formatEther(currentPrice));
          await provider.send('evm_increaseTime', [60 * 10]); // Add 10 minutes
          await provider.send('evm_mine', []);
        }

        for (let i = 0; i < 6; i++) {
          const currentPrice = await contract.currentDaPrice();
          expect(currentPrice).to.eq(parseEther('0.6')); // stay
          await provider.send('evm_increaseTime', [60 * 10]); // Add 10 minutes
          await provider.send('evm_mine', []);
        }
      });
    });
  });

  describe('when giving refunds', () => {
    let snapshot;
    beforeEach(async () => {
      snapshot = await provider.send('evm_snapshot', []);
      const now = (await provider.getBlock(await provider.getBlockNumber()))
        .timestamp;

      await contract.setPhaseTimes(
        now - 1, // e.g. just started
        now + 60 * 60 * 24 * 1,
        now + 60 * 60 * 24 * 2,
        now + 60 * 60 * 24 * 3
      );
    });
    afterEach(async () => {
      if (snapshot) {
        await provider.send('evm_revert', [snapshot]);
      }
    });

    it('should refund someone', async () => {
      await as(alice);
      const paid = parseEther('2.5');
      await contract.bidSummon(1, { value: paid });
      expect(await contract.daAmountPaid(alice.address)).to.eq(paid);
      expect(await contract.daNumMinted(alice.address)).to.eq(1);
      expect(await contract.numSold()).to.eq(1);

      {
        await as(wallet);
        await contract.setFinalPrice(parseEther('1'));
      }

      const expectedRefund = parseEther('1.5');
      expect(await contract.refundOwed(alice.address)).to.eq(expectedRefund);
      expect(await contract.numDaMinters()).to.eq(1);

      const balanceBeforeRefund = await provider.getBalance(alice.address);
      await contract.issueRefunds(0, 0);
      expect(await contract.refundOwed(alice.address)).to.eq(0);
      const balanceAfterRefund = await provider.getBalance(alice.address);
      expect(balanceAfterRefund).to.equal(
        balanceBeforeRefund.add(expectedRefund)
      );
    });

    describe('when a non-refunder tries', () => {
      beforeEach(() => {
        contract = contract.connect(eve);
      });

      it('should not allow issueRefunds', async () => {
        await expect(contract.issueRefunds(0, 0)).to.be.revertedWith(
          'caller is not the refunder'
        );
      });

      it('should not allow refundAddress', async () => {
        await expect(contract.refundAddress(eve.address)).to.be.revertedWith(
          'caller is not the refunder'
        );
      });
    });

    it('should refund someone who bought more than once', async () => {
      {
        await as(alice);
        await contract.bidSummon(1, { value: parseEther('2.5') });
        expect(await contract.daAmountPaid(alice.address)).to.eq(
          parseEther('2.5')
        );
        expect(await contract.daNumMinted(alice.address)).to.eq(1);
        expect(await contract.numSold()).to.eq(1);
      }

      await ethers.provider.send('evm_increaseTime', [60 * 60 * 1]); // Add 1 hour
      await provider.send('evm_mine', []);

      {
        await as(bob);

        await contract.bidSummon(2, { value: parseEther('4.4') });
        expect(await contract.daAmountPaid(bob.address)).to.eq(
          parseEther('4.4')
        );
        expect(await contract.daNumMinted(bob.address)).to.eq(2);
        expect(await contract.numSold()).to.eq(3);
      }

      await ethers.provider.send('evm_increaseTime', [60 * 60 * 1]); // Add 1 hour
      await provider.send('evm_mine', []);

      // const price = await contract.currentDaPrice();
      // console.log('price: ', price);

      {
        await as(alice);

        await contract.bidSummon(2, { value: parseEther('1.9').mul(2) });
        expect(await contract.daAmountPaid(alice.address)).to.eq(
          parseEther('2.5').add(parseEther('1.9').mul(2))
        );
        expect(await contract.daNumMinted(alice.address)).to.eq(3);
        expect(await contract.numSold()).to.eq(5);
      }

      {
        await as(wallet);
        await contract.setFinalPrice(parseEther('1'));
      }

      const aliceBalanceBeforeRefund = await provider.getBalance(alice.address);
      const bobBalanceBeforeRefund = await provider.getBalance(bob.address);
      const contractBalanceBeforeRefund = await provider.getBalance(
        contract.address
      );

      const aliceExpectedRefund = parseEther('3.3');
      const bobExpectedRefund = parseEther('2.4');

      expect(await contract.numDaMinters()).to.eq(3);

      expect(await contract.refundOwed(alice.address)).to.eq(
        aliceExpectedRefund
      );
      expect(await contract.refundOwed(bob.address)).to.eq(bobExpectedRefund);

      const tx = await contract.issueRefunds(0, 1);
      const receipt = await tx.wait();
      printGasEstimate({ gasAmount: BigNumber.from(receipt.gasUsed), gwei });

      expect(await contract.refundOwed(alice.address)).to.eq(0);
      expect(await contract.refundOwed(bob.address)).to.eq(0);

      const aliceBalanceAfterRefund = await provider.getBalance(alice.address);
      const bobBalanceAfterRefund = await provider.getBalance(bob.address);
      const contractBalanceAfterRefund = await provider.getBalance(
        contract.address
      );

      expect(aliceBalanceAfterRefund).to.equal(
        aliceBalanceBeforeRefund.add(aliceExpectedRefund)
      );
      expect(bobBalanceAfterRefund).to.equal(
        bobBalanceBeforeRefund.add(bobExpectedRefund)
      );
      expect(contractBalanceAfterRefund).to.equal(
        contractBalanceBeforeRefund.sub(
          aliceExpectedRefund.add(bobExpectedRefund)
        )
      );
    });
    it.skip('should have reasonable gas to refund', async () => {
      // generate a bunch of wallets, send them eth
      for (let i = 0; i < 100; i++) {
        let tmpWallet = await createFundedWallet(
          provider,
          bob,
          parseEther('2.6')
        );
        contract = contract.connect(tmpWallet);
        await contract.bidSummon(1, { value: parseEther('2.5') });
      }
      expect(await contract.numSold()).to.eq(100);

      contract = contract.connect(wallet);

      const contractBalanceBeforeRefund = await provider.getBalance(
        contract.address
      );
      expect(contractBalanceBeforeRefund).to.equal(parseEther('2.5').mul(100));

      await contract.setFinalPrice(parseEther('1'));
      const tx = await contract.issueRefunds(0, 99);
      const receipt = await tx.wait();
      printGasEstimate({ gasAmount: BigNumber.from(receipt.gasUsed), gwei });

      const contractBalanceAfterFirstRefund = await provider.getBalance(
        contract.address
      );
      expect(contractBalanceAfterFirstRefund).to.equal(
        parseEther('1').mul(100)
      );

      const tx2 = await contract.issueRefunds(0, 99);
      const receipt2 = await tx2.wait();
      printGasEstimate({ gasAmount: BigNumber.from(receipt2.gasUsed), gwei });

      const contractBalanceAfterSecondRefund = await provider.getBalance(
        contract.address
      );
      expect(contractBalanceAfterSecondRefund).to.equal(
        parseEther('1').mul(100)
      );
    });
    it('should enumerate refunding');

    describe('when a griefer buys', () => {
      beforeEach(async () => {
        const contractFactory = await ethers.getContractFactory(
          'MaliciousWarriorBuyer',
          wallet
        );
        maliciousBuyer = await contractFactory.deploy();
        await maliciousBuyer.deployed();
      });
      it('should refund a griefer', async () => {
        await maliciousBuyer.bid(contract.address, 1, {
          value: parseEther('2.5'),
        });
        await contract.setFinalPrice(parseEther('1'));
        expect(await contract.refundOwed(maliciousBuyer.address)).to.eq(
          parseEther('1.5')
        );

        const contractBalanceBeforeRefund = await provider.getBalance(
          contract.address
        );
        expect(contractBalanceBeforeRefund).to.equal(parseEther('2.5'));

        const grieferBalanceBeforeRefund = await provider.getBalance(
          maliciousBuyer.address
        );
        expect(await weth.balanceOf(maliciousBuyer.address)).to.equal(0);

        const tx = await contract.issueRefunds(0, 0);
        const receipt = await tx.wait();

        const contractBalanceAfterRefund = await provider.getBalance(
          contract.address
        );
        expect(contractBalanceAfterRefund).to.equal(parseEther('1'));
        const grieferBalanceAfterRefund = await provider.getBalance(
          maliciousBuyer.address
        );

        expect(grieferBalanceAfterRefund).to.equal(grieferBalanceBeforeRefund); // ETH same
        expect(await weth.balanceOf(maliciousBuyer.address)).to.equal(
          parseEther('1.5')
        ); // WETH up
      });
    });
    it('should not issue a self refund before time, but should at time', async () => {
      //
      {
        await as(alice);
        await contract.bidSummon(1, { value: parseEther('2.5') });
        expect(await contract.daAmountPaid(alice.address)).to.eq(
          parseEther('2.5')
        );
        expect(await contract.daNumMinted(alice.address)).to.eq(1);
        expect(await contract.numSold()).to.eq(1);
      }

      await as(wallet);
      await contract.setFinalPrice(parseEther('0.6'));

      {
        await as(alice);
        const tx = contract.selfRefund();
        expect(tx).to.be.revertedWith('Self refund period not started');
      }

      await as(wallet);
      let now = (await provider.getBlock(await provider.getBlockNumber()))
        .timestamp;
      await contract.setSelfRefundsStartTime(now - 60);
      await provider.send('evm_mine', []);

      {
        await as(alice);

        const aliceBalanceBeforeRefund = await provider.getBalance(
          alice.address
        );

        const tx = await contract.selfRefund();
        const receipt = await tx.wait();
        const gasCostEth = receipt.gasUsed.mul(receipt.effectiveGasPrice);

        const aliceBalanceAfterRefund = await provider.getBalance(
          alice.address
        );
        expect(aliceBalanceAfterRefund).to.eq(
          aliceBalanceBeforeRefund.add(parseEther('1.9')).sub(gasCostEth)
        );
      }
    });
  });

  describe('during mintlist phase', () => {
    let snapshot;
    let price, now;
    let mintlistTree;
    beforeEach(async () => {
      snapshot = await provider.send('evm_snapshot', []);
      now = (await provider.getBlock(await provider.getBlockNumber()))
        .timestamp;

      await contract.setFinalPrice(parseEther('1.1'));
      price = parseEther('1.1');

      await contract.setPhaseTimes(
        now - 60 * 60 * 1,
        now - 60, // e.g. just started
        now + 60 * 60 * 2,
        now + 60 * 60 * 3
      );

      const { merkleTree } = makeMintlistMerkles([alice.address, bob.address]);
      mintlistTree = merkleTree;
      await contract.setMintlist1MerkleRoot(merkleTree.getHexRoot());
    });
    afterEach(async () => {
      if (snapshot) {
        await provider.send('evm_revert', [snapshot]);
      }
    });

    it(`should mint if you're on the list`, async () => {
      as(bob);
      await expect(
        contract.mintlistSummon(
          mintlistTree.getHexProof(
            solidityKeccak256(['address'], [bob.address])
          ),
          {
            value: price,
          }
        )
      )
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 0);
    });

    it('should mint if dutch auction did not sell out', async () => {
      expect(await contract.numSold()).to.eq(0);
      as(bob);
      await expect(
        contract.mintlistSummon(
          mintlistTree.getHexProof(
            solidityKeccak256(['address'], [bob.address])
          ),
          {
            value: price,
          }
        )
      )
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 0);
      expect(await contract.numSold()).to.eq(1);
    });
    it('should not mint when not started', async () => {
      await contract.setPhaseTimes(
        now - 60 * 60 * 1,
        now + 60 * 60 * 1,
        now + 60 * 60 * 2,
        now + 60 * 60 * 3
      );

      as(bob);
      const tx = contract.mintlistSummon(
        mintlistTree.getHexProof(solidityKeccak256(['address'], [bob.address])),
        {
          value: price,
        }
      );
      await expect(tx).to.be.revertedWith('Mintlist phase not started');
    });
    it('should not mint when the value is incorrect', async () => {
      as(bob);
      {
        const tx = contract.mintlistSummon(
          mintlistTree.getHexProof(
            solidityKeccak256(['address'], [bob.address])
          ),
          {
            value: price.add(1),
          }
        );
        await expect(tx).to.be.revertedWith('Ether value incorrect');
      }

      {
        const tx = contract.mintlistSummon(
          mintlistTree.getHexProof(
            solidityKeccak256(['address'], [bob.address])
          )
        );
        await expect(tx).to.be.revertedWith('Ether value incorrect');
      }

      {
        const tx = contract.mintlistSummon(
          mintlistTree.getHexProof(
            solidityKeccak256(['address'], [bob.address])
          ),
          {
            value: price.sub(1),
          }
        );
        await expect(tx).to.be.revertedWith('Ether value incorrect');
      }
    });
    it('should not mint if you already minted', async () => {
      as(bob);
      await expect(
        contract.mintlistSummon(
          mintlistTree.getHexProof(
            solidityKeccak256(['address'], [bob.address])
          ),
          {
            value: price,
          }
        )
      )
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 0);

      const tx = contract.mintlistSummon(
        mintlistTree.getHexProof(solidityKeccak256(['address'], [bob.address])),
        {
          value: price,
        }
      );
      await expect(tx).to.be.revertedWith('Already minted');
    });
    it(`should not mint if you're not in the list`, async () => {
      as(eve);
      const tx = contract.mintlistSummon(
        mintlistTree.getHexProof(solidityKeccak256(['address'], [bob.address])),
        {
          value: price,
        }
      );
      expect(tx).to.be.revertedWith('Invalid proof');
    });

    describe('after a sellout da', () => {
      beforeEach(async () => {
        await contract.setPhaseTimes(
          now,
          now + 60 * 60 * 1,
          now + 60 * 60 * 2,
          now + 60 * 60 * 3
        );
        await contract.setFinalPrice(parseEther('2.5'));
        await contract.setMaxDaSupply(20);
        await contract.bidSummon(20, { value: parseEther('2.5').mul(20) });

        await wallet.sendTransaction({
          to: bob.address,
          value: parseEther('100'),
        });

        await provider.send('evm_increaseTime', [60 * 60 + 1]);
        await provider.send('evm_mine', []);
        expect(await contract.mintlistStarted()).to.eq(true);
      });
      it('should mint if dutch auction sold out', async () => {
        const finalPrice = await contract.finalPrice();
        expect(finalPrice).to.eq(parseEther('2.5'));

        as(bob);
        await expect(
          contract.mintlistSummon(
            mintlistTree.getHexProof(
              solidityKeccak256(['address'], [bob.address])
            ),
            {
              value: parseEther('2.5'),
            }
          )
        )
          .to.emit(warriorsContract, 'Transfer')
          .withArgs(AddressZero, bob.address, 20);
      });
      it('should not mint when sold out', async () => {
        await contract.setMaxForSale(20);
        expect(await contract.numSold()).to.eq(20);
        const tx = contract.mintlistSummon(
          mintlistTree.getHexProof(
            solidityKeccak256(['address'], [bob.address])
          ),
          {
            value: price,
          }
        );
        await expect(tx).to.be.revertedWith('Sold out');
      });
    });
  });

  describe('during public phase', () => {
    let price, now;

    beforeEach(async () => {
      price = await contract.finalPrice();
      now = (await provider.getBlock(await provider.getBlockNumber()))
        .timestamp;

      await contract.setPhaseTimes(
        now - 60 * 60 * 3,
        now - 60 * 60 * 2,
        now - 60 * 60 * 1,
        now + 60 * 60 * 3
      );
      expect(await contract.publicStarted()).to.eq(true);
      as(bob);
    });
    it('should mint one', async () => {
      await expect(
        contract.publicSummon(1, {
          value: price,
        })
      )
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 0);
      expect(await contract.numSold()).to.eq(1);
    });
    it('should mint many', async () => {
      await expect(
        contract.publicSummon(1, {
          value: price,
        })
      )
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 0);
      expect(await contract.numSold()).to.eq(1);

      await expect(
        contract.publicSummon(2, {
          value: price.mul(2),
        })
      )
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 1);
      expect(await contract.numSold()).to.eq(3);
    });
    it('should mint 20', async () => {
      await expect(
        contract.publicSummon(20, {
          value: price.mul(20),
        })
      )
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 0);
      expect(await contract.numSold()).to.eq(20);
    });
    it('should not let you mint 0', async () => {
      const tx = contract.publicSummon(0);
      await expect(tx).to.be.revertedWith(
        'You can summon no more than 20 Warriors at a time'
      );
    });
    it('should not let you mint more than 20', async () => {
      const tx = contract.publicSummon(21, { value: price.mul(21) });
      await expect(tx).to.be.revertedWith(
        'You can summon no more than 20 Warriors at a time'
      );
    });
    it('should not let you mint at an incorrect price', async () => {
      {
        const tx = contract.publicSummon(1, { value: 1 });
        await expect(tx).to.be.revertedWith('Ether value sent is incorrect');
      }
      {
        const tx = contract.publicSummon(1, { value: price.add(1) });
        await expect(tx).to.be.revertedWith('Ether value sent is incorrect');
      }
    });

    it('should not sell more than the amount for sale', async () => {
      contract = contract.connect(wallet);
      await contract.setMaxForSale(20);

      contract = contract.connect(bob);
      await expect(
        contract.publicSummon(20, {
          value: price.mul(20),
        })
      )
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 0);
      expect(await contract.numSold()).to.eq(20);

      const tx = contract.publicSummon(1, { value: price });
      await expect(tx).to.be.revertedWith('Sold out');
    });
    it('should not let you buy too many at the edges', async () => {
      contract = contract.connect(wallet);
      await contract.setMaxForSale(20);

      contract = contract.connect(bob);
      await expect(
        contract.publicSummon(18, {
          value: price.mul(18),
        })
      )
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 0);
      expect(await contract.numSold()).to.eq(18);

      const tx = contract.publicSummon(3, { value: price.mul(3) });
      await expect(tx).to.be.revertedWith('Not enough remaining');
    });
  });

  describe('when claiming a free mint', () => {
    let price, now, aliceProof, bobProof;

    beforeEach(async () => {
      price = await contract.finalPrice();
      now = (await provider.getBlock(await provider.getBlockNumber()))
        .timestamp;

      await contract.setPhaseTimes(
        now - 60 * 60 * 4,
        now - 60 * 60 * 3,
        now - 60 * 60 * 2,
        now - 60 * 60 * 1
      );
      expect(await contract.claimsStarted()).to.eq(true);
      await contract.setClaimlistMerkleRoot(claimlistMerkleTree.getHexRoot());

      aliceProof = claimlistMerkleTree.getHexProof(
        solidityKeccak256(['address'], [alice.address])
      );
      bobProof = claimlistMerkleTree.getHexProof(
        solidityKeccak256(['address'], [bob.address])
      );
      as(bob);
    });
    it(`should let you claim one`, async () => {
      await expect(contract.claimSummon(bobProof))
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 0);
      expect(await contract.numSold()).to.eq(0);
      expect(await contract.numClaimed()).to.eq(1);
    });
    it(`should not let you claim two`, async () => {
      await expect(contract.claimSummon(bobProof))
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 0);
      expect(await contract.numSold()).to.eq(0);
      expect(await contract.numClaimed()).to.eq(1);

      const tx = contract.claimSummon(bobProof);
      await expect(tx).to.be.revertedWith('Already claimed');
    });
    it(`should not let you claim if you're not in the list`, async () => {
      as(eve);
      const tx = contract.claimSummon(bobProof);
      await expect(tx).to.be.revertedWith('Invalid proof');
    });
    it('should not let you claim when all are claimed', async () => {
      as(wallet);
      await contract.setMaxForClaim(1);

      as(bob);
      await expect(contract.claimSummon(bobProof))
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, bob.address, 0);
      expect(await contract.numSold()).to.eq(0);
      expect(await contract.numClaimed()).to.eq(1);

      {
        const tx = contract.claimSummon(bobProof);
        await expect(tx).to.be.revertedWith('No more claims');
      }

      {
        as(alice);
        const tx = contract.claimSummon(aliceProof);
        await expect(tx).to.be.revertedWith('No more claims');
      }
    });
  });

  describe('when the team mints', () => {
    it('should allow the team to mint', async () => {
      const tx = contract.teamSummon(wallet.address, 20);
      await expect(tx)
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, wallet.address, 0);
    });
    it('should not allow not-owner to mint', async () => {
      as(eve);
      const tx = contract.teamSummon(wallet.address, 3);
      await expect(tx).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('when withdrawing funds', () => {
    let now, price;
    beforeEach(async () => {
      price = await contract.finalPrice();
      now = (await provider.getBlock(await provider.getBlockNumber()))
        .timestamp;

      await contract.setPhaseTimes(
        now - 60 * 60 * 3,
        now - 60 * 60 * 2,
        now - 60 * 60 * 1,
        now + 60 * 60 * 3
      );

      await expect(
        contract.publicSummon(20, {
          value: price.mul(20),
        })
      )
        .to.emit(warriorsContract, 'Transfer')
        .withArgs(AddressZero, wallet.address, 1);

      await contract.setVaultAddress(carol.address);
    });
    it('should allow the owner to withdraw all', async () => {
      const balanceBeforeWithdraw = await provider.getBalance(carol.address);
      await contract.withdrawAll();
      expect(await provider.getBalance(carol.address)).to.eq(
        balanceBeforeWithdraw.add(price.mul(20))
      );
    });
    it('should allow the owner to withdraw an arbitrary amount', async () => {
      const balanceBeforeWithdraw = await provider.getBalance(carol.address);
      await contract.withdraw(100);
      expect(await provider.getBalance(carol.address)).to.eq(
        balanceBeforeWithdraw.add(100)
      );
    });
    it('should allow the owner to withdrawClassic an arbitrary amount', async () => {
      const balanceBeforeWithdraw = await provider.getBalance(carol.address);
      await contract.withdrawClassic(99);
      expect(await provider.getBalance(carol.address)).to.eq(
        balanceBeforeWithdraw.add(99)
      );
    });
    it('should not allow someone other than owner to withdraw', async () => {
      as(eve);
      const tx = contract.withdraw(1000);
      await expect(tx).to.be.revertedWith('Ownable: caller is not the owner');
    });
    it('should not allow someone other than owner to withdrawClassic', async () => {
      as(eve);
      const tx = contract.withdrawClassic(1000);
      await expect(tx).to.be.revertedWith('Ownable: caller is not the owner');
    });
    it('should not allow someone other than owner to withdraw all', async () => {
      as(eve);
      const tx = contract.withdrawAll();
      await expect(tx).to.be.revertedWith('Ownable: caller is not the owner');
    });
  });

  describe('before sale', () => {
    it('owner should be the deployer', async () => {
      expect(await contract.owner()).to.eq(wallet.address);
    });

    describe('the contract', () => {
      it('has basic info', async () => {
        expect(await contract.warriors()).to.eq(warriorsContract.address);
        expect(await contract.weth()).to.eq(weth.address);
        expect(await contract.maxDaSupply()).to.eq(8000);
        expect(await contract.paused()).to.eq(false);
        expect(await contract.daStarted()).to.eq(false);
        expect(await contract.mintlistStarted()).to.eq(false);
        expect(await contract.publicStarted()).to.eq(false);
        expect(await contract.numDaMinters()).to.eq(0);
      });
    });
  });

  describe('when configuring', () => {
    describe('when a non-owner tries', () => {
      beforeEach(() => {
        contract = contract.connect(eve);
      });
      it('should not pause', async () => {
        await expect(contract.pause()).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not unpause', async () => {
        await expect(contract.unpause()).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setDaStartTime', async () => {
        await expect(contract.setDaStartTime(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setMintlistStartTime', async () => {
        await expect(contract.setMintlistStartTime(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setPublicStartTime', async () => {
        await expect(contract.setPublicStartTime(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setClaimsStartTime', async () => {
        await expect(contract.setClaimsStartTime(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setSelfRefundsStartTime', async () => {
        await expect(contract.setSelfRefundsStartTime(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setPhaseTimes', async () => {
        await expect(contract.setPhaseTimes(1, 1, 1, 1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setMintlist1MerkleRoot', async () => {
        await expect(
          contract.setMintlist1MerkleRoot(mintlist1MerkleTree.getHexRoot())
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
      it('should not setMintlist2MerkleRoot', async () => {
        await expect(
          contract.setMintlist2MerkleRoot(mintlist2MerkleTree.getHexRoot())
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
      it('should not setClaimlistMerkleRoot', async () => {
        await expect(
          contract.setClaimlistMerkleRoot(claimlistMerkleTree.getHexRoot())
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
      it('should not setVaultAddress', async () => {
        await expect(contract.setVaultAddress(eve.address)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setWarriorsAddress', async () => {
        await expect(
          contract.setWarriorsAddress(eve.address)
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
      it('should not setWethAddress', async () => {
        await expect(contract.setWethAddress(eve.address)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setRefunderAddress', async () => {
        await expect(
          contract.setRefunderAddress(eve.address)
        ).to.be.revertedWith('Ownable: caller is not the owner');
      });
      it('should not setStartPrice', async () => {
        await expect(contract.setStartPrice(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setLowestPrice', async () => {
        await expect(contract.setLowestPrice(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setDaPriceCurveLength', async () => {
        await expect(contract.setDaPriceCurveLength(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setDaDropInterval', async () => {
        await expect(contract.setDaDropInterval(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setFinalPrice', async () => {
        await expect(contract.setFinalPrice(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setMaxDaSupply', async () => {
        await expect(contract.setMaxDaSupply(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not setMaxForClaim', async () => {
        await expect(contract.setMaxForClaim(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not withdraw', async () => {
        await expect(contract.withdraw(1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not withdrawAll', async () => {
        await expect(contract.withdrawAll()).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not forwardERC20s', async () => {
        await expect(contract.forwardERC20s(eve.address, 1)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
    });
    describe('when the owner tries', () => {
      it('should pause and unpause', async () => {
        await contract.pause();
        expect(await contract.paused()).to.equal(true);

        await contract.unpause();
        expect(await contract.paused()).to.equal(false);
      });
      it('should setDaStartTime', async () => {
        await contract.setDaStartTime(3);
        expect(await contract.daStartTime()).to.equal(3);
      });
      it('should setMintlistStartTime', async () => {
        await contract.setMintlistStartTime(3);
        expect(await contract.mintlistStartTime()).to.equal(3);
      });
      it('should setPublicStartTime', async () => {
        await contract.setPublicStartTime(3);
        expect(await contract.publicStartTime()).to.equal(3);
      });
      it('should setClaimsStartTime', async () => {
        await contract.setClaimsStartTime(3);
        expect(await contract.claimsStartTime()).to.equal(3);
      });
      it('should setSelfRefundsStartTime', async () => {
        await contract.setSelfRefundsStartTime(3);
        expect(await contract.selfRefundsStartTime()).to.equal(3);
      });
      it('should setPhaseTimes', async () => {
        await contract.setPhaseTimes(2, 3, 4, 5);
        expect(await contract.daStartTime()).to.equal(2);
        expect(await contract.mintlistStartTime()).to.equal(3);
        expect(await contract.publicStartTime()).to.equal(4);
        expect(await contract.claimsStartTime()).to.equal(5);
      });
      it('should setMintlist1MerkleRoot', async () => {
        await contract.setMintlist1MerkleRoot(mintlist1MerkleTree.getHexRoot());
        expect(await contract.mintlist1MerkleRoot()).to.equal(
          mintlist1MerkleTree.getHexRoot()
        );
      });
      it('should setMintlist2MerkleRoot', async () => {
        await contract.setMintlist2MerkleRoot(mintlist2MerkleTree.getHexRoot());
        expect(await contract.mintlist2MerkleRoot()).to.equal(
          mintlist2MerkleTree.getHexRoot()
        );
      });
      it('should setClaimlistMerkleRoot', async () => {
        await contract.setClaimlistMerkleRoot(claimlistMerkleTree.getHexRoot());
        expect(await contract.claimlistMerkleRoot()).to.equal(
          claimlistMerkleTree.getHexRoot()
        );
      });
      it('should setVaultAddress', async () => {
        await contract.setVaultAddress(wallet.address);
        expect(await contract.vault()).to.equal(wallet.address);
      });
      it('should setWarriorsAddress', async () => {
        await contract.setWarriorsAddress(wallet.address);
        expect(await contract.warriors()).to.equal(wallet.address);
      });
      it('should setWethAddress', async () => {
        await contract.setWethAddress(wallet.address);
        expect(await contract.weth()).to.equal(wallet.address);
      });
      it('should setRefunderAddress', async () => {
        await contract.setRefunderAddress(wallet.address);
        expect(await contract.refunder()).to.equal(wallet.address);
      });
      it('should setStartPrice', async () => {
        await contract.setStartPrice(123);
        expect(await contract.startPrice()).to.equal(123);
      });
      it('should setLowestPrice', async () => {
        await contract.setStartPrice(123);
        expect(await contract.startPrice()).to.equal(123);
      });
      it('should setDaPriceCurveLength', async () => {
        await contract.setDaPriceCurveLength(123);
        expect(await contract.daPriceCurveLength()).to.equal(123);
      });
      it('should setDaDropInterval', async () => {
        await contract.setDaDropInterval(123);
        expect(await contract.daDropInterval()).to.equal(123);
      });
      it('should setFinalPrice', async () => {
        await contract.setFinalPrice(parseEther('0.6'));
        expect(await contract.finalPrice()).to.equal(parseEther('0.6'));
      });
      it('should not setFinalPrice below lowest price', async () => {
        await expect(contract.setFinalPrice(1)).to.be.revertedWith(
          'finalPrice cant be less than lowestPrice'
        );
      });
      it('should setMaxDaSupply', async () => {
        await contract.setMaxDaSupply(123);
        expect(await contract.maxDaSupply()).to.equal(123);
      });
      it('should setMaxForClaim', async () => {
        await contract.setMaxForClaim(123);
        expect(await contract.maxForClaim()).to.equal(123);
      });
      it('should deposit funds', async () => {
        const balanceBeforeDeposit = await provider.getBalance(
          contract.address
        );
        await contract.deposit({ value: 123 });
        const balanceAfterDeposit = await provider.getBalance(contract.address);
        expect(balanceAfterDeposit).to.equal(balanceBeforeDeposit.add(123));
      });
    });
  });
});

// nodemon --exec ./node_modules/.bin/hardhat test --network hardhat test/ForgottenRunesWarriorsGuildMinter.spec.ts
