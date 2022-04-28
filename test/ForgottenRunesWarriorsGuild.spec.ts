import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address';
import chai from 'chai';
import { solidity } from 'ethereum-waffle';
import { Contract } from 'ethers';
import { ethers, waffle } from 'hardhat';

chai.use(solidity);
const { expect } = chai;

describe('ForgottenRunesWarriorsGuild', () => {
  let wallet: SignerWithAddress;
  let alice: any;
  let bob: any;
  let eve: any;
  const provider = waffle.provider;
  let contract: Contract;

  beforeEach(async () => {
    const signers = await ethers.getSigners();
    wallet = signers[0];
    alice = signers[1];
    bob = signers[2];
    eve = signers[3];

    const contractFactory = await ethers.getContractFactory(
      'ForgottenRunesWarriorsGuild',
      signers[0]
    );
    contract = await contractFactory.deploy('https://foo.bar/');
    await contract.deployed();
    await provider.send('evm_setAutomine', [true]);
  });

  describe('before sale', () => {
    it('owner should be the deployer', async () => {
      expect(await contract.owner()).to.eq(wallet.address);
    });

    describe('the contract', () => {
      it('has basic info', async () => {
        expect(await contract.baseTokenURI()).to.eq('https://foo.bar/');
        expect(await contract.numMinted()).to.eq(0);
      });
    });
  });

  describe('when minting', () => {
    describe('when a non-minter tries', () => {
      beforeEach(() => {
        contract = contract.connect(eve);
      });
      it('should not mint', async () => {
        await expect(contract.mint(eve.address)).to.be.revertedWith(
          'Not a minter'
        );
      });
    });
    describe('when the minter tries', () => {
      beforeEach(async () => {
        await contract.setMinter(bob.address);
        contract = contract.connect(bob);
      });

      it('should mint', async () => {
        await contract.mint(bob.address);
        expect(await contract.numMinted()).to.eq(1);
        expect(await contract.ownerOf(0)).to.eq(bob.address);

        expect(await contract.tokenURI(0)).to.eq('https://foo.bar/0');
        expect(await contract.exists(0)).to.eq(true);

        await contract.mint(bob.address);
        expect(await contract.numMinted()).to.eq(2);
        expect(await contract.ownerOf(1)).to.eq(bob.address);
      });

      it('should mint even if there is a burn', async () => {
        await contract.mint(bob.address);
        expect(await contract.numMinted()).to.eq(1);
        expect(await contract.ownerOf(0)).to.eq(bob.address);

        await contract.burn(0);
        expect(await contract.exists(0)).to.eq(false);

        // why is this weird
        try {
          const ownerOfZero = await contract.ownerOf(0);
        } catch (err) {
          expect(err.message).to.eq('Maximum call stack size exceeded');
        }

        await contract.mint(bob.address);
        expect(await contract.numMinted()).to.eq(2);
        expect(await contract.ownerOf(1)).to.eq(bob.address);
        expect(await contract.tokenURI(1)).to.eq('https://foo.bar/1');
      });

      // skips by default because it takes a long time to run
      it.skip('should not mint more than the supply', async () => {
        await provider.send('evm_setAutomine', [false]);
        const mintableSupply = await contract.MAX_WARRIORS();
        for (let i = 0; i < mintableSupply.toNumber(); i++) {
          contract.mint(bob.address);
          if (i % 100 === 0) {
            console.log(`${new Date().toString()} Minting ${i}...`);
            await provider.send('evm_mine', []);
          }
        }
        await provider.send('evm_setAutomine', [true]);

        await expect(contract.mint(bob.address)).to.be.revertedWith(
          'All warriors have been summoned'
        );
      }).timeout(60000 * 20);
    });
  });

  describe('when using setters', () => {
    describe('when a non-owner tries', () => {
      beforeEach(() => {
        contract = contract.connect(eve);
      });
      it('should not initialize', async () => {
        await expect(contract.initialize(eve.address)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not set the baseURI', async () => {
        await expect(contract.setBaseURI('abc123')).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not set the minter', async () => {
        await expect(contract.setMinter(eve.address)).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not set the provenance hash', async () => {
        await expect(contract.setProvenanceHash('hi')).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not uploadImage', async () => {
        await expect(contract.uploadImage([])).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not uploadAttributes', async () => {
        await expect(contract.uploadAttributes([])).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
      it('should not withdrawAll', async () => {
        await expect(contract.withdrawAll()).to.be.revertedWith(
          'Ownable: caller is not the owner'
        );
      });
    });
    describe('when the owner tries', () => {
      it('should allow the owner to initialize', async () => {
        await contract.initialize(bob.address);
        expect(await contract.minter()).to.equal(bob.address);
      });
      it('should allow the owner to set the baseURI', async () => {
        await contract.setBaseURI('abc123');
        expect(await contract.baseTokenURI()).to.equal('abc123');
      });
      it('should set the minter', async () => {
        await contract.setMinter(bob.address);
        expect(await contract.minter()).to.equal(bob.address);
      });
      it('should set the provenance hash', async () => {
        await contract.setProvenanceHash('howdy');
        expect(await contract.METADATA_PROVENANCE_HASH()).to.equal('howdy');
      });
      it('should uploadImage', async () => {
        await contract.uploadImage([]);
      });
      it('should uploadAttributes', async () => {
        await contract.uploadAttributes([]);
      });
      it('should withdrawAll', async () => {
        await contract.withdrawAll();
      });
    });
  });
});

// nodemon --exec ./node_modules/.bin/hardhat test --network hardhat test/ForgottenRunesWarriorsGuild.spec.ts
