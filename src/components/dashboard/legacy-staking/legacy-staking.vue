<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import moment from 'moment'
import { useWalletStore } from '@/stores/wallet'
import {
  formatNetworkName,
  getLegacyStakingNetworks,
  getTransactionExplorerUrl
} from '@/services/network-config'
import { isUserRejectedError } from '@/services/contract'
import { formatBigInt18Precise } from '@/services/token'
import { QuestionCircleOutlined } from '@ant-design/icons-vue'
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
const isNodeUnstaking = ref(false)
const delegationTransactions = reactive({})
const lastDelegationTransaction = ref(null)

const selectedNetwork = computed(() => getLegacyStakingNetworks()[selectedNetworkKey.value])
const legacyContracts = computed(() => selectedNetwork.value?.legacyStakingContracts)
const nativeSymbol = computed(() => selectedNetwork.value?.nativeCurrency?.symbol || 'CNX')
const forceAvailableAt = computed(() => {
  if (!nodeInfo.value) return 0n
  return nodeInfo.value.unstakeTimestamp + nodeInfo.value.forceUnstakeDelay
})
const hasNodeStake = computed(() => (nodeInfo.value?.stakedBalance || 0n) > 0n)
const canTryUnstake = computed(() => (
  hasNodeStake.value && nodeInfo.value?.status === LegacyStakingStatus.STAKED
))
const canForceUnstake = computed(() => {
  if (nodeInfo.value?.status !== LegacyStakingStatus.PENDING_UNSTAKE) return false
  return nowSeconds.value >= forceAvailableAt.value
})
const isPendingUnstake = computed(() => (
  nodeInfo.value?.status === LegacyStakingStatus.PENDING_UNSTAKE && !canForceUnstake.value
))
const forceUnstakeAvailableTime = computed(() => {
  if (nodeInfo.value?.status !== LegacyStakingStatus.PENDING_UNSTAKE) return ''
  return moment.unix(Number(forceAvailableAt.value)).format('YYYY-MM-DD HH:mm:ss')
})
const pendingUnstakeMessage = computed(() => {
  if (!isPendingUnstake.value) return ''
  return `Please come back after ${forceUnstakeAvailableTime.value} to force unstake.`
})

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
  return formatBigInt18Precise(amount || 0n)
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

async function handleTryUnstake() {
  if (!window.ethereum) {
    message.error('No wallet provider')
    return
  }
  isNodeUnstaking.value = true
  try {
    await tryLegacyNodeUnstake(selectedNetworkKey.value, legacyContracts.value)
    message.success('Unstake request submitted. Come back after the waiting period to force unstake.')
    await refresh()
  } catch (error) {
    console.error('Legacy node unstake transaction failed', {
      network: selectedNetworkKey.value,
      action: 'try',
      error
    })
    if (isUserRejectedError(error)) {
      message.error('Transaction rejected')
    } else {
      message.error('Unstake request failed: ' + (error.reason || error.message || 'Unknown error'))
    }
  } finally {
    isNodeUnstaking.value = false
  }
}

async function handleForceUnstake() {
  if (!window.ethereum) {
    message.error('No wallet provider')
    return
  }
  isNodeUnstaking.value = true
  try {
    await forceLegacyNodeUnstake(selectedNetworkKey.value, legacyContracts.value)
    message.success('Force unstake completed')
    await wallet.refreshAccountAndBalance()
    await refresh()
  } catch (error) {
    console.error('Legacy node unstake transaction failed', {
      network: selectedNetworkKey.value,
      action: 'force',
      error
    })
    if (isUserRejectedError(error)) {
      message.error('Transaction rejected')
    } else {
      message.error('Force unstake failed: ' + (error.reason || error.message || 'Unknown error'))
    }
  } finally {
    isNodeUnstaking.value = false
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
    <a-alert
      type="info"
      show-icon
      message="Unstake from the deprecated staking contracts"
      description="These actions interact directly with the previous contracts."
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
          <a-alert
            v-if="nodeInfo && nodeInfo.status === LegacyStakingStatus.UNSTAKED"
            type="success"
            show-icon
            message="No node stake in the deprecated node staking contract."
            style="width: 100%; margin-bottom: 16px"
          />
          <a-alert
            v-else-if="isPendingUnstake"
            type="warning"
            show-icon
            :message="pendingUnstakeMessage"
            style="width: 100%; margin-bottom: 16px"
          />
          <a-descriptions v-if="nodeInfo" bordered :column="{ xs: 1, md: 2 }">
            <a-descriptions-item label="Network">
              {{ formatNetworkName(selectedNetworkKey) }}
            </a-descriptions-item>
            <a-descriptions-item label="Staking contract">
              {{ legacyContracts.nodeStaking }}
            </a-descriptions-item>
            <a-descriptions-item label="Node address">
              {{ wallet.address }}
            </a-descriptions-item>
            <a-descriptions-item label="Staking amount">
              <span>{{ formatAmount(nodeInfo.stakedBalance) }} {{ nativeSymbol }}</span>
              <template v-if="hasNodeStake">
                <a-button
                  v-if="canTryUnstake"
                  type="primary"
                  size="small"
                  :loading="isNodeUnstaking"
                  @click="handleTryUnstake"
                  style="margin-left: 8px;"
                >Unstake</a-button>
                <a-button
                  v-else-if="canForceUnstake"
                  type="primary"
                  size="small"
                  :loading="isNodeUnstaking"
                  @click="handleForceUnstake"
                  style="margin-left: 8px;"
                >Force Unstake</a-button>
                <a-button
                  v-else-if="isPendingUnstake"
                  type="primary"
                  size="small"
                  disabled
                  style="margin-left: 8px;"
                >Pending Unstake</a-button>
              </template>
            </a-descriptions-item>
            <a-descriptions-item :span="2">
              <template #label>
                <span style="display: inline-flex; align-items: center; white-space: nowrap;">
                  <span>Beneficial Address</span>
                  <a-popover placement="right">
                    <template #content>
                      <div style="max-width: 300px;">
                        <div>The beneficial address is a dedicated wallet for safely receiving your funds. For security, your operational address should not hold funds. All withdrawals, unstaking payouts, and emissions will be sent to this address. Choose a wallet you control and plan to keep using. Once set, this address is permanent and cannot be changed.</div>
                        <div style="margin-top: 8px">If not set, the operational address will be used for payouts.</div>
                      </div>
                    </template>
                    <QuestionCircleOutlined style="margin-left: 6px; color: #888; cursor: pointer;" />
                  </a-popover>
                </span>
              </template>
              <span v-if="nodeInfo.benefitAddress">{{ nodeInfo.benefitAddress }}</span>
              <span v-else>Not set</span>
            </a-descriptions-item>
          </a-descriptions>
        </a-card>

        <a-card title="Delegated Staking">
          <a-alert
            v-if="!delegations.length"
            type="success"
            show-icon
            message="No delegated stake in the deprecated delegated staking contract."
            style="width: 100%; margin-bottom: 16px"
          />
          <a-descriptions bordered :column="{ xs: 1, md: 2 }">
            <a-descriptions-item label="Network">
              {{ formatNetworkName(selectedNetworkKey) }}
            </a-descriptions-item>
            <a-descriptions-item label="Staking contract">
              {{ legacyContracts.delegatedStaking }}
            </a-descriptions-item>
            <a-descriptions-item label="Wallet address" :span="2">
              {{ wallet.address }}
            </a-descriptions-item>
            <a-descriptions-item :span="2">
              <template #label>
                <span style="display: inline-flex; align-items: center; white-space: nowrap;">
                  <span>Beneficial Address</span>
                  <a-popover placement="right">
                    <template #content>
                      <div style="max-width: 300px;">
                        <div>The beneficial address is a dedicated wallet for safely receiving your funds. For security, your operational address should not hold funds. All withdrawals, unstaking payouts, and emissions will be sent to this address. Choose a wallet you control and plan to keep using. Once set, this address is permanent and cannot be changed.</div>
                        <div style="margin-top: 8px">If not set, the operational address will be used for payouts.</div>
                      </div>
                    </template>
                    <QuestionCircleOutlined style="margin-left: 6px; color: #888; cursor: pointer;" />
                  </a-popover>
                </span>
              </template>
              <span v-if="nodeInfo?.benefitAddress">{{ nodeInfo.benefitAddress }}</span>
              <span v-else>Not set</span>
            </a-descriptions-item>
          </a-descriptions>
          <a-list
            v-if="delegations.length"
            :data-source="delegations"
            item-layout="horizontal"
            style="margin-top: 16px"
          >
            <template #renderItem="{ item }">
              <a-list-item>
                <a-list-item-meta>
                  <template #title>
                    {{ item.nodeAddress }}
                  </template>
                  <template #description>
                    {{ formatAmount(item.amount) }} {{ nativeSymbol }}
                    <div v-if="delegationTransactions[item.nodeAddress]?.status === 'pending'">Transaction pending…</div>
                    <div v-if="delegationTransactions[item.nodeAddress]?.status === 'error'">
                      {{ delegationTransactions[item.nodeAddress].error }}
                    </div>
                  </template>
                </a-list-item-meta>
                <a-button
                  danger
                  :loading="delegationTransactions[item.nodeAddress]?.status === 'pending'"
                  @click="runDelegationUnstake(item.nodeAddress)"
                >Unstake</a-button>
              </a-list-item>
            </template>
          </a-list>
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
