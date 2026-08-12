<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { ethers } from 'ethers'
import { message } from 'ant-design-vue'
import { useWalletStore } from '@/stores/wallet'
import {
  formatNetworkName,
  getAddressExplorerUrl,
  getLegacyStakingNetworks,
  getTransactionExplorerUrl
} from '@/services/network-config'
import { isUserRejectedError } from '@/services/contract'
import {
  forceLegacyNodeUnstake,
  getLegacyDelegations,
  getLegacyNodeStakingInfo,
  LegacyStakingStatus,
  tryLegacyNodeUnstake,
  unstakeLegacyDelegation
} from '@/services/legacy-staking'

const wallet = useWalletStore()
const networks = Object.entries(getLegacyStakingNetworks())
const selectedNetworkKey = ref(networks[0]?.[0] || '')
const loading = ref(false)
const loadError = ref('')
const nodeInfo = ref(null)
const delegations = ref([])
const nowSeconds = ref(BigInt(Math.floor(Date.now() / 1000)))
const nodeTransaction = reactive({ status: '', hash: '', error: '' })
const delegationTransactions = reactive({})
const lastDelegationTransaction = ref(null)

const selectedNetwork = computed(() => getLegacyStakingNetworks()[selectedNetworkKey.value])
const legacyContracts = computed(() => selectedNetwork.value?.legacyStakingContracts)
const nativeSymbol = computed(() => selectedNetwork.value?.nativeCurrency?.symbol || 'CNX')
const forceAvailableAt = computed(() => {
  if (!nodeInfo.value) return 0n
  return nodeInfo.value.unstakeTimestamp + nodeInfo.value.forceUnstakeDelay
})
const canForceUnstake = computed(() => (
  nodeInfo.value?.status === LegacyStakingStatus.PENDING_UNSTAKE &&
  nowSeconds.value > forceAvailableAt.value
))

let clockTimer
onMounted(() => {
  clockTimer = window.setInterval(() => {
    nowSeconds.value = BigInt(Math.floor(Date.now() / 1000))
  }, 1000)
  refresh()
})
onBeforeUnmount(() => window.clearInterval(clockTimer))

watch(selectedNetworkKey, refresh)
watch(() => wallet.address, refresh)

function formatAmount(amount) {
  return ethers.formatUnits(amount || 0n, selectedNetwork.value?.nativeCurrency?.decimals ?? 18)
}

function formatUtc8(timestamp) {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date(Number(timestamp) * 1000)) + ' UTC+8'
}

function stakingStatusLabel(status) {
  if (status === LegacyStakingStatus.STAKED) return 'Staked'
  if (status === LegacyStakingStatus.PENDING_UNSTAKE) return 'Pending Unstaked'
  return 'Unstaked'
}

function errorMessage(error) {
  if (isUserRejectedError(error)) return 'User rejected the transaction.'
  return error?.shortMessage || error?.reason || 'Transaction failed. Please try again.'
}

async function refresh() {
  if (!wallet.address || !selectedNetworkKey.value || !legacyContracts.value) return
  loading.value = true
  loadError.value = ''
  try {
    const [nextNodeInfo, nextDelegations] = await Promise.all([
      getLegacyNodeStakingInfo(selectedNetworkKey.value, legacyContracts.value, wallet.address),
      getLegacyDelegations(selectedNetworkKey.value, legacyContracts.value, wallet.address)
    ])
    nodeInfo.value = nextNodeInfo
    delegations.value = nextDelegations
  } catch (error) {
    console.error('Failed to load legacy staking state', {
      network: selectedNetworkKey.value,
      walletAddress: wallet.address,
      error
    })
    loadError.value = 'Could not load legacy staking data. Please try again later.'
    message.error(loadError.value)
  } finally {
    loading.value = false
  }
}

async function runNodeTransaction(action) {
  nodeTransaction.status = 'pending'
  nodeTransaction.hash = ''
  nodeTransaction.error = ''
  try {
    const result = action === 'try'
      ? await tryLegacyNodeUnstake(selectedNetworkKey.value, legacyContracts.value)
      : await forceLegacyNodeUnstake(selectedNetworkKey.value, legacyContracts.value)
    nodeTransaction.status = 'success'
    nodeTransaction.hash = result.hash
    message.success('Transaction confirmed.')
    await wallet.refreshAccountAndBalance()
    await refresh()
  } catch (error) {
    console.error('Legacy node unstake transaction failed', {
      network: selectedNetworkKey.value,
      action,
      error
    })
    nodeTransaction.status = 'error'
    nodeTransaction.error = errorMessage(error)
    message.error(nodeTransaction.error)
  }
}

async function runDelegationUnstake(nodeAddress) {
  delegationTransactions[nodeAddress] = { status: 'pending', hash: '', error: '' }
  try {
    const result = await unstakeLegacyDelegation(
      selectedNetworkKey.value,
      legacyContracts.value,
      nodeAddress
    )
    delegationTransactions[nodeAddress] = { status: 'success', hash: result.hash, error: '' }
    lastDelegationTransaction.value = { nodeAddress, hash: result.hash }
    message.success('Delegation unstake confirmed.')
    await wallet.refreshAccountAndBalance()
    await refresh()
  } catch (error) {
    console.error('Legacy delegation unstake transaction failed', {
      network: selectedNetworkKey.value,
      nodeAddress,
      error
    })
    const text = errorMessage(error)
    delegationTransactions[nodeAddress] = { status: 'error', hash: '', error: text }
    message.error(text)
  }
}
</script>

<template>
  <a-space direction="vertical" size="large" style="width: 100%">
    <a-typography-title :level="2">Legacy Staking</a-typography-title>
    <a-alert
      type="info"
      show-icon
      message="Withdraw funds from the previous staking contracts"
      description="These actions interact directly with the previous contracts and do not use Relay staking data."
    />

    <a-select
      v-if="networks.length > 1"
      v-model:value="selectedNetworkKey"
      style="width: 280px"
      aria-label="Legacy staking network"
    >
      <a-select-option v-for="[key] in networks" :key="key" :value="key">
        {{ formatNetworkName(key) }}
      </a-select-option>
    </a-select>

    <a-alert v-if="loadError" type="error" show-icon :message="loadError" />

    <a-spin :spinning="loading">
      <a-space direction="vertical" size="large" style="width: 100%">
        <a-card title="Node Staking">
          <a-descriptions v-if="nodeInfo" bordered :column="{ xs: 1, md: 2 }">
            <a-descriptions-item label="Network">
              {{ formatNetworkName(selectedNetworkKey) }}
            </a-descriptions-item>
            <a-descriptions-item label="Previous contract">
              <a
                :href="getAddressExplorerUrl(selectedNetworkKey, legacyContracts.nodeStaking)"
                target="_blank"
                rel="noopener noreferrer"
              >{{ legacyContracts.nodeStaking }}</a>
            </a-descriptions-item>
            <a-descriptions-item label="Node address">
              {{ nodeInfo.nodeAddress }}
            </a-descriptions-item>
            <a-descriptions-item label="Native stake">
              {{ formatAmount(nodeInfo.stakedBalance) }} {{ nativeSymbol }}
            </a-descriptions-item>
            <a-descriptions-item label="Status">
              <a-tag>{{ stakingStatusLabel(nodeInfo.status) }}</a-tag>
            </a-descriptions-item>
            <a-descriptions-item label="Unstake requested">
              {{ formatUtc8(nodeInfo.unstakeTimestamp) }}
            </a-descriptions-item>
            <a-descriptions-item label="Native refund recipient" :span="2">
              <a
                :href="getAddressExplorerUrl(selectedNetworkKey, nodeInfo.refundAddress)"
                target="_blank"
                rel="noopener noreferrer"
              >{{ nodeInfo.refundAddress }}</a>
              <div>The native {{ nativeSymbol }} refund is sent to the configured BenefitAddress, or to the node wallet when no BenefitAddress is set.</div>
            </a-descriptions-item>
          </a-descriptions>

          <a-space v-if="nodeInfo" direction="vertical" style="margin-top: 16px">
            <a-popconfirm
              v-if="nodeInfo.status === LegacyStakingStatus.STAKED"
              title="Request withdrawal from the previous NodeStaking contract?"
              ok-text="Request Unstake"
              @confirm="runNodeTransaction('try')"
            >
              <a-button type="primary" :loading="nodeTransaction.status === 'pending'">
                Request Unstake
              </a-button>
            </a-popconfirm>
            <template v-else-if="nodeInfo.status === LegacyStakingStatus.PENDING_UNSTAKE">
              <a-alert
                v-if="!canForceUnstake"
                type="warning"
                show-icon
                :message="`Force unstake becomes available after ${formatUtc8(forceAvailableAt)}`"
              />
              <a-popconfirm
                v-else
                title="Force withdrawal from the previous NodeStaking contract?"
                ok-text="Force Unstake"
                @confirm="runNodeTransaction('force')"
              >
                <a-button type="primary" danger :loading="nodeTransaction.status === 'pending'">
                  Force Unstake
                </a-button>
              </a-popconfirm>
            </template>
            <a-alert
              v-else
              type="success"
              show-icon
              message="Node staking withdrawal is complete."
            />
            <a-alert v-if="nodeTransaction.status === 'pending'" type="info" show-icon message="Transaction pending…" />
            <a-alert v-if="nodeTransaction.status === 'error'" type="error" show-icon :message="nodeTransaction.error" />
            <a-alert v-if="nodeTransaction.status === 'success'" type="success" show-icon message="Transaction confirmed">
              <template #description>
                <a :href="getTransactionExplorerUrl(selectedNetworkKey, nodeTransaction.hash)" target="_blank" rel="noopener noreferrer">
                  View transaction
                </a>
              </template>
            </a-alert>
          </a-space>
        </a-card>

        <a-card title="Delegated Staking">
          <template v-if="delegations.length">
            <a-list :data-source="delegations" item-layout="horizontal">
              <template #renderItem="{ item }">
                <a-list-item>
                  <a-list-item-meta>
                    <template #title>
                      <a :href="getAddressExplorerUrl(selectedNetworkKey, item.nodeAddress)" target="_blank" rel="noopener noreferrer">
                        {{ item.nodeAddress }}
                      </a>
                    </template>
                    <template #description>
                      {{ formatAmount(item.amount) }} {{ nativeSymbol }}
                      <div v-if="delegationTransactions[item.nodeAddress]?.status === 'pending'">Transaction pending…</div>
                      <div v-if="delegationTransactions[item.nodeAddress]?.status === 'error'">
                        {{ delegationTransactions[item.nodeAddress].error }}
                      </div>
                    </template>
                  </a-list-item-meta>
                  <a-popconfirm
                    title="Withdraw this entire delegation from the previous contract?"
                    ok-text="Unstake"
                    @confirm="runDelegationUnstake(item.nodeAddress)"
                  >
                    <a-button
                      danger
                      :loading="delegationTransactions[item.nodeAddress]?.status === 'pending'"
                    >Unstake</a-button>
                  </a-popconfirm>
                </a-list-item>
              </template>
            </a-list>
          </template>
          <a-empty v-else description="No active delegations in the previous contract." />
          <a-alert
            v-if="lastDelegationTransaction"
            type="success"
            show-icon
            message="Delegation unstake confirmed"
            style="margin-top: 16px"
          >
            <template #description>
              <a
                :href="getTransactionExplorerUrl(selectedNetworkKey, lastDelegationTransaction.hash)"
                target="_blank"
                rel="noopener noreferrer"
              >View transaction</a>
            </template>
          </a-alert>
        </a-card>
      </a-space>
    </a-spin>
  </a-space>
</template>
