import { WeiPerEther } from '@ethersproject/constants';
import { formatEther, parseUnits } from '@ethersproject/units';
import { BigNumber } from 'ethers';

export function printGasEstimate({
  gasAmount,
  gwei,
  ethusd,
}: {
  gasAmount: BigNumber;
  gwei?: string;
  ethusd?: number;
}) {
  const gasPrice = parseUnits(gwei || '100', 'gwei');
  const ethUsdCents = (ethusd || 4000) * 100;

  const gasCostEth = BigNumber.from(gasAmount.mul(BigNumber.from(gasPrice)));

  const gasCostUsd = gasAmount
    .mul(BigNumber.from(gasPrice))
    .mul(ethUsdCents)
    .div(BigNumber.from(WeiPerEther));

  const results = {
    gasCostUsd: gasCostUsd.toNumber() / 100,
    gasCostEth: formatEther(gasCostEth),
    gasUsed: gasAmount.toNumber(),
  };
  console.log('        ⛽ gas:', results);

  return results;
}
