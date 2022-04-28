const dotenvPath = process.env.DEPLOY_ENV
  ? fs.existsSync(`.env.${process.env.DEPLOY_ENV}`)
    ? `.env.${process.env.DEPLOY_ENV}`
    : '.env'
  : '.env';
require('dotenv').config({
  path: dotenvPath,
});
import 'solidity-coverage';
import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-etherscan';
import '@nomiclabs/hardhat-waffle';
import '@openzeppelin/hardhat-upgrades';
import * as fs from 'fs';
import 'hardhat-typechain';
import { task } from 'hardhat/config';
import { HardhatUserConfig } from 'hardhat/types';
import 'hardhat-gas-reporter';

const deployerPaths = {
  default: {
    deploy: './deploy',
    deployments: './deployments',
  },
};

type DeployerConfig = {
  namedAccounts: {
    [key: string]: number | string;
  };
};

const config: HardhatUserConfig & DeployerConfig = {
  defaultNetwork: 'hardhat',
  solidity: {
    compilers: [
      {
        version: '0.8.6',
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
      {
        version: '0.8.1',
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
      {
        version: '0.8.0',
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
      {
        version: '0.7.3',
        settings: {
          optimizer: { enabled: true, runs: 200 },
        },
      },
    ],
  },
  namedAccounts: {
    deployer: 0,
  },
  networks: {
    hardhat: {
      chainId: 31337,
      loggingEnabled: false,
    },
    coverage: {
      url: 'http://127.0.0.1:8555',
    },
    // if you want these, then set them
    // localhost: {
    //   url: process.env.NETWORK_URL,
    // },
    // rinkeby: {
    //   url: process.env.RINKEBY_HTTP_ENDPOINT,
    // },
    // mainnet: {
    //   url: process.env.ALCHEMY_HTTP_ENDPOINT,
    // },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_TOKEN,
  },
  paths: {
    sources: './contracts',
    artifacts: './artifacts',
    ...deployerPaths[process.env.DEPLOYER_ENV || 'default'],
  },
  gasReporter: {
    currency: 'USD',
    enabled: process.env.REPORT_GAS === 'true',
    excludeContracts: ['contracts/test/', 'contracts/interfaces/'],
  },
};

export default config;

task('blockNumber', 'Prints the block number', async (_, { ethers }) => {
  const blockNumber = await ethers.provider.getBlockNumber();
  console.log(blockNumber);
});
