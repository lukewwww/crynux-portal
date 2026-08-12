import legacyV1NodeStakingAbi from '@/abi/legacy-v1-node-staking.json'
import legacyV1DelegatedStakingAbi from '@/abi/legacy-v1-delegated-staking.json'
import legacyV1BeneficialAddressAbi from '@/abi/legacy-v1-beneficial-address.json'

const profiles = Object.freeze({
  'legacy-v1': Object.freeze({
    nodeStaking: legacyV1NodeStakingAbi,
    delegatedStaking: legacyV1DelegatedStakingAbi,
    beneficialAddress: legacyV1BeneficialAddressAbi
  })
})

export function getLegacyStakingAbiProfile(profileName) {
  const profile = profiles[profileName]
  if (!profile) {
    throw new Error(`Unsupported legacy staking ABI profile: ${profileName}`)
  }
  return profile
}
