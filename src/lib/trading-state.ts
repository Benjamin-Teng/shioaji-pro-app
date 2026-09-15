import { onTradeMutation } from './trade-mutations';
import { useEffect, useSyncExternalStore } from 'react';
import { getAccountState, refreshAccounts, useAccounts } from './account-store';
import { ensureContract, getCachedContract } from './contracts-cache';
import { getApiBase } from './runtime';
import { subscribeProductionTradeEvents } from './boot';
import { retainQuote } from './quote-ownership';
import { onTradeResponse } from './trade-observations';
import { fetchAccountBalance, fetchMargin, fetchPositions, fetchTrades } from './shioaji';
import { ensureStream, getStreamStatus, onAnyTick, onOrderEvent, subscribeStatusStore } from './stream';
import { applyPositionFill, markPosition, positionFill, reportBody } from './portfolio-projection';
import { projectOrderReport, projectTradeDeal } from './order-projection';
import type { OrderEventReport } from './order-report';
import type { AccountBalance, AccountedPosition, AccountFunds, Margin } from './types/portfolio';
import type { AccountedTrade } from './types/order';

export type TradingQueryScope = 'positions' | 'orders' | 'account';
export interface TradingQueryStatus { updatedAt: number | null; needsReconcile: boolean; error: string | null }
const queryScopes: TradingQueryScope[] = ['positions', 'orders', 'account'];
const emptyQuery = (): TradingQueryStatus => ({ updatedAt: null, needsReconcile: false, error: null });
export interface TradingState {
    queries: Record<TradingQueryScope, TradingQueryStatus>;
    positions: AccountedPosition[];
    trades: AccountedTrade[];
    funds?: AccountFunds[];
    balance?: AccountBalance;
    margin?: Margin;
    balanceAccount?: string;
    marginAccount?: string;
    updatedAt: number | null;
    loading: boolean;
    needsReconcile: boolean;
    error: string | null;
}
let state: TradingState = { queries: { positions: emptyQuery(), orders: emptyQuery(), account: emptyQuery() }, positions: [], trades: [], updatedAt: null, loading: false, needsReconcile: false, error: null };
const listeners = new Set<() => void>();
const isMirror = typeof location !== 'undefined' && new URLSearchParams(location.search).has('popout');
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(`sj-trading-state:${getApiBase()}`) : null;
function updateQuery(scope: TradingQueryScope, patch: Partial<TradingQueryStatus>) {
    const queries = { ...state.queries, [scope]: { ...state.queries[scope], ...patch } };
    state = { ...state, queries,
        needsReconcile: queryScopes.some(key => queries[key].needsReconcile),
        error: [...new Set(queryScopes.map(key => queries[key].error).filter(Boolean))].join('；') || null,
        updatedAt: Math.max(...queryScopes.map(key => queries[key].updatedAt ?? 0)) || null,
    };
}
function markStale(scope: TradingQueryScope, error: string) { updateQuery(scope, { needsReconcile: true, error }); }
let publishTimer: ReturnType<typeof setTimeout> | null = null;
function publish() {
    listeners.forEach(l => l());
    if (!isMirror) channel?.postMessage({ kind: 'state', state });
}
function schedulePublish() {
    if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; publish(); }, 50);
}
channel?.addEventListener('message', e => {
    if (isMirror && e.data?.kind === 'state' && Array.isArray(e.data.state?.positions)
        && Array.isArray(e.data.state?.trades)) {
        state = e.data.state;
        publish();
    } else if (!isMirror && e.data?.kind === 'request') publish();
    else if (!isMirror && e.data?.kind === 'refresh' && queryScopes.includes(e.data.scope)) void refreshTradingState(e.data.scope);
});

let inFlight: Promise<void> | null = null;
const snapshotEnds = new Map<string, number>();
const seenFills = new Set<string>();
const pendingDeals = new Map<string, OrderEventReport>();
const pendingContracts = new Set<string>();
const orderTimes = new Map<string, number>();
const pendingOrders = new Map<string, OrderEventReport>();
let queryEvents: OrderEventReport[] | null = null;
let queryOverflow = false;
let connectionEpoch = 0;
const nextRefreshAt: Record<TradingQueryScope, number> = { positions: 0, orders: 0, account: 0 };
let eventSequence = 0;
const accountKey = (a: { broker_id: string; account_id: string; account_type: string }) => `${a.account_type}:${a.broker_id}:${a.account_id}`;

const positionQuotes = new Map<string, { release?: () => void }>();
function prepareQuotes() {
    const codes = new Set(state.positions.map(p => p.code));
    for (const [code, entry] of positionQuotes) if (!codes.has(code)) { entry.release?.(); positionQuotes.delete(code); }
    for (const code of codes) if (!positionQuotes.has(code)) {
        const entry: { release?: () => void } = {};
        positionQuotes.set(code, entry);
        void ensureContract(code).then(contract => {
            if (positionQuotes.get(code) === entry) entry.release = retainQuote(contract, 'Tick');
        }).catch(() => { if (positionQuotes.get(code) === entry) positionQuotes.delete(code); });
    }
}

/** Initial connection reads all groups; manual actions reconcile only their tab. */
export function refreshTradingState(scope: TradingQueryScope | 'all' = 'all'): Promise<void> {
    if (isMirror) {
        if (scope !== 'all') channel?.postMessage({ kind: 'refresh', scope });
        return Promise.resolve();
    }
    if (inFlight) return inFlight;
    const targets = scope === 'all' ? queryScopes : [scope];
    if (targets.some(key => Date.now() < nextRefreshAt[key])) return Promise.resolve();
    const readPositions = targets.includes('positions');
    const readOrders = targets.includes('orders');
    const readAccount = targets.includes('account');
    inFlight = (async () => {
        const before = eventSequence;
        const connectionBefore = connectionEpoch;
        state = { ...state, loading: true };
        for (const key of targets) updateQuery(key, { error: null });
        publish();
        const errors: Record<TradingQueryScope, string[]> = { positions: [], orders: [], account: [] };
        queryEvents = readOrders ? [] : null;
        queryOverflow = false;
        try {
            if (readPositions || readOrders) await subscribeProductionTradeEvents();
            if (!getAccountState().accounts.length) await refreshAccounts();
            const accounts = getAccountState().accounts.filter(a => a.signed && ['S', 'F'].includes(a.account_type));
            if (!accounts.length) throw new Error('尚未取得可查詢帳戶；請連線後按更新');
            for (const account of accounts) {
                const matches = (a: typeof account | undefined) => a && accountKey(a) === accountKey(account);
                if (readPositions) try {
                    const positionStart = eventSequence;
                    const hadSnapshot = snapshotEnds.has(accountKey(account));
                    const positions = await fetchPositions(account.account_type as 'S' | 'F', account);
                    if (positionStart === eventSequence || !hadSnapshot) {
                        snapshotEnds.set(accountKey(account), Date.now() / 1000);
                        state = { ...state, positions: [...state.positions.filter(p => !matches(p.account)), ...positions.map(p => ({ ...p, account }))] };
                    }
                    // Without a server watermark, do not add a fill on top of
                    // a snapshot that might already include it.
                    if (positionStart !== eventSequence) errors.positions.push('持倉查詢期間收到回報，保留即時估算；快照邊界待確認');
                } catch { errors.positions.push(`${account.account_type} 持倉查詢失敗，保留上次資料`); }
                if (readOrders) try {
                    const trades = await fetchTrades(account.account_type as 'S' | 'F', account);
                    let merged = [...state.trades.filter(t => !matches(t.account)), ...trades
                        .filter(t => !t.order.account || (t.order.account.account_id === account.account_id && t.order.account.broker_id === account.broker_id))
                        .map(t => ({ ...t, account }))];
                    for (const report of queryEvents ?? []) {
                        const projected = report.kind === 'order'
                            ? projectOrderReport(merged, report, accounts) : projectTradeDeal(merged, report);
                        if (projected) merged = projected;
                        else errors.orders.push('委託更新期間有無法銜接的回報，保留本地資料待確認');
                    }
                    if (!queryOverflow && !errors.orders.some(e => e.includes('無法銜接'))) state = { ...state, trades: merged };
                } catch { errors.orders.push(`${account.account_type} 委託查詢失敗，保留上次資料`); }
            }
            if (readAccount) {
                const funds: AccountFunds[] = [];
                for (const account of accounts) {
                    const previous = state.funds?.find(f => accountKey(f.account) === accountKey(account));
                    try {
                        const value = account.account_type === 'S'
                            ? { balance: await fetchAccountBalance(account) }
                            : { margin: await fetchMargin(account) };
                        if (value.balance?.errmsg?.trim()) throw new Error('券商餘額查詢回報錯誤');
                        funds.push({ account, ...value, updatedAt: Date.now() });
                    } catch {
                        const error = `${account.account_type === 'S' ? '餘額' : '保證金'}查詢失敗，保留此帳戶上次資料`;
                        funds.push({ ...previous, account, error });
                        errors.account.push(error);
                    }
                }
                const stock = getAccountState().selectedStock ?? accounts.find(a => a.account_type === 'S');
                const future = getAccountState().selectedFutures ?? accounts.find(a => a.account_type === 'F');
                state = { ...state, funds,
                    balance: funds.find(f => stock && accountKey(f.account) === accountKey(stock))?.balance,
                    margin: funds.find(f => future && accountKey(f.account) === accountKey(future))?.margin,
                    balanceAccount: stock && accountKey(stock), marginAccount: future && accountKey(future) };
            }
            if (readPositions) prepareQuotes();
        } catch (e) { for (const key of targets) errors[key].push(e instanceof Error ? e.message : String(e)); }
        if (queryOverflow && readOrders) errors.orders.push('更新期間回報過多，已保留即時資料；請稍後手動確認');
        for (const key of targets) {
            if (connectionBefore !== connectionEpoch || getStreamStatus() !== 'live') errors[key].push('串流曾中斷，資料可能不完整；請連線後手動確認');
            if (before !== eventSequence) errors[key].push('更新期間收到回報，快照邊界不明；請確認後手動對帳');
            updateQuery(key, { needsReconcile: errors[key].length > 0, error: errors[key].join('；') || null,
                ...(errors[key].length === 0 ? { updatedAt: Date.now() } : {}) });
        }
        state = { ...state, loading: false };
        publish();
    })().finally(() => { queryEvents = null; for (const key of targets) nextRefreshAt[key] = Date.now() + 1500; inFlight = null; });
    return inFlight;
}

let started = false;
let hasConnected = false;
function applyDeal(report: OrderEventReport) {
    if (report.kind !== 'deal') return;
    const fill = positionFill(report, getAccountState().accounts, state.trades);
    const trades = projectTradeDeal(state.trades, report);
    if (trades) state = { ...state, trades };
    else {
        markStale('orders', '成交回報缺少委託資料，委託狀態待對帳');
        if (pendingDeals.size < 500) pendingDeals.set(JSON.stringify(report.raw), report);
    }
    if (fill && seenFills.has(fill.key)) return;
    const cutoff = fill && snapshotEnds.get(accountKey(fill.account));
    const c = fill && getCachedContract(fill.code);
    if (fill?.account.account_type === 'F' && !c) {
        if (pendingDeals.size < 500) pendingDeals.set(JSON.stringify(report.raw), report);
        if (!pendingContracts.has(fill.code)) {
            pendingContracts.add(fill.code);
            // Metadata only: several fills of a new contract share this lookup.
            void ensureContract(fill.code).then(() => {
                for (const [key, pending] of [...pendingDeals]) {
                    if (positionFill(pending, getAccountState().accounts, state.trades)?.code !== fill.code) continue;
                    pendingDeals.delete(key);
                    applyDeal(pending);
                }
                schedulePublish();
            }).catch(() => undefined).finally(() => pendingContracts.delete(fill.code));
        }
    }
    const multiplier = fill?.account.account_type === 'S' ? 1 : c?.multiplier ?? c?.contract_size ?? 0;
    const next = fill && cutoff && fill.ts > cutoff
        ? applyPositionFill(state.positions, fill, multiplier) : null;
    if (next && fill && seenFills.size < 10000) {
        seenFills.add(fill.key);
        state = { ...state, positions: next };
        prepareQuotes();
    } else {
        markStale('positions', '成交資料或快照邊界不足，持倉待手動對帳');
        // Deal-before-order is documented. Retain a bounded pending set;
        // receiving order metadata later can resolve it without any query.
        if (!fill && pendingDeals.size < 500) pendingDeals.set(JSON.stringify(report.raw), report);
    }
}
function start() {
    if (started) return;
    started = true;
    if (isMirror) { channel?.postMessage({ kind: 'request' }); return; }
    const mutationBaselines = new Map<string, { trade: AccountedTrade | undefined; sequence: number }>();
    const stopMutations = onTradeMutation(event => {
        if (event.phase === 'begin') {
            const matches = state.trades.filter(t => t.order.id === event.tradeId);
            if (mutationBaselines.size >= 500) mutationBaselines.delete(mutationBaselines.keys().next().value!);
            mutationBaselines.set(event.token, { trade: matches.length === 1 ? matches[0] : undefined, sequence: eventSequence });
            return;
        }
        const baseline = mutationBaselines.get(event.token);
        const old = baseline?.trade;
        mutationBaselines.delete(event.token);
        const trade = event.trade;
        const account = trade?.order?.account;
        // Preserve every newer SSE/snapshot result. Never insert an unknown or
        // ambiguously scoped response, nor turn an old working state into finality.
        const sameAccount = old?.account && account && accountKey(old.account) === accountKey(account);
        if (old && baseline?.sequence === eventSequence && state.trades.includes(old) && sameAccount && trade?.order.id === event.tradeId
            && ['Cancelled', 'Filled'].includes(trade.status.status)
            && trade.status.deal_quantity >= old.status.deal_quantity
            && trade.status.cancel_quantity >= old.status.cancel_quantity) {
            if (trade.status.deal_quantity > old.status.deal_quantity) markStale('positions', '刪單／改單回應包含新增成交；持倉尚待回報或手動對帳');
            state = { ...state, trades: state.trades.map(t => t === old ? { ...trade, account: old.account } : t) };
        } else {
            markStale('orders', '刪單／改單結果待確認；請手動更新委託，不要自動重送');
        }
        if (queryEvents) queryOverflow = true;
        schedulePublish();
    });
    const stopResponses = onTradeResponse(({ trade, account: requestedAccount }) => {
        const ref = trade.order.account ?? requestedAccount;
        const account = getAccountState().accounts.find(a => a.signed && a.account_type === ref?.account_type
            && a.account_id === ref?.account_id && a.broker_id === ref?.broker_id);
        if (!account) return;
        const old = state.trades.find(t => t.order.id === trade.order.id && t.account && accountKey(t.account) === accountKey(account));
        // A response may arrive after newer reports. Keep their quantities,
        // prices/status and only enrich metadata missing from the event schema.
        if (old) {
            state = { ...state, trades: state.trades.map(t => t !== old ? t : { ...t, order: { ...t.order,
                custom_field: t.order.custom_field || trade.order.custom_field,
                price_type: t.order.price_type || trade.order.price_type,
                order_type: t.order.order_type || trade.order.order_type } }) };
        } else state = { ...state, trades: [...state.trades, { ...trade, account }] };
        // A native New event can omit full_code before the HTTP response has
        // supplied canonical metadata. Replay only the same account/id and code.
        const pendingKey = `${account.account_type === 'S' ? 'stock' : 'futures'}:${account.broker_id}:${account.account_id}:${trade.order.id}`;
        const pendingOrder = pendingOrders.get(pendingKey);
        if (pendingOrder && pendingOrder.kind === 'order' && !old
            && ['PendingSubmit', 'PreSubmitted'].includes(trade.status.status)
            && (!pendingOrder.ts || pendingOrder.ts >= (orderTimes.get(pendingKey) ?? 0))) {
            const body = reportBody(pendingOrder);
            const eventContract = body?.contract as { code?: string; full_code?: string } | undefined;
            const canonical = trade.contract.target_code || trade.contract.code;
            if ((eventContract?.full_code || eventContract?.code) === canonical) {
                const projected = projectOrderReport(state.trades, pendingOrder, getAccountState().accounts);
                if (projected) {
                    state = { ...state, trades: projected };
                    if (pendingOrder.ts) orderTimes.set(pendingKey, pendingOrder.ts);
                    pendingOrders.delete(pendingKey);
                }
            }
        }
        // Do not allow an in-flight snapshot to overwrite a response that was
        // received afterwards; the user can explicitly reconcile once settled.
        if (queryEvents) queryOverflow = true;
        for (const [key, deal] of [...pendingDeals]) {
            if (deal.kind === 'deal' && deal.tradeId === trade.order.id) { pendingDeals.delete(key); applyDeal(deal); }
        }
        schedulePublish();
    });
    const stopOrders = onOrderEvent(report => {
        eventSequence++;
        if (queryEvents && queryEvents.length >= 1000) queryOverflow = true;
        // Events never trigger HTTP accounting queries. Unknown/missing events
        // keep the last view and surface explicit reconciliation instead.
        if (report.kind === 'deal') {
            if (queryEvents && queryEvents.length < 1000) queryEvents.push(report);
            applyDeal(report);
        }
        else {
            const ref = (reportBody(report)?.order as { account?: { broker_id?: string; account_id?: string } })?.account;
            const key = `${report.market}:${ref?.broker_id}:${ref?.account_id}:${report.id}`;
            if (report.ts && report.ts < (orderTimes.get(key) ?? 0)) return;
            if (queryEvents && queryEvents.length < 1000) queryEvents.push(report);
            const trades = projectOrderReport(state.trades, report, getAccountState().accounts);
            if (trades) {
                state = { ...state, trades };
                if (report.ts) orderTimes.set(key, report.ts);
                for (const [key2, deal] of [...pendingDeals]) {
                    if (deal.kind === 'deal' && deal.tradeId === report.id) { pendingDeals.delete(key2); applyDeal(deal); }
                }
            } else {
                const previous = pendingOrders.get(key);
                if (report.opType === 'New' && (!previous?.ts || (report.ts ?? 0) >= previous.ts)) {
                    if (pendingOrders.size >= 500 && !pendingOrders.has(key)) pendingOrders.delete(pendingOrders.keys().next().value!);
                    pendingOrders.set(key, report);
                }
                markStale('orders', '回報已收到；委託快照待手動對帳');
            }
        }
        schedulePublish();
    });
    const stopTicks = onAnyTick(tick => {
        const price = Number(tick.close);
        if (!Number.isFinite(price) || price <= 0 || tick.simtrade) return;
        let changed = false;
        const positions = state.positions.map(p => {
            if (p.code !== tick.code) return p;
            const c = getCachedContract(p.code);
            const multiplier = p.account?.account_type === 'S' ? 1 : c?.multiplier ?? c?.contract_size ?? 0;
            const next = markPosition(p, price, multiplier);
            changed ||= next !== p;
            return next;
        });
        if (changed) { state = { ...state, positions }; schedulePublish(); }
    });
    const statusChanged = () => {
        const live = getStreamStatus() === 'live';
        if (live && !hasConnected) { hasConnected = true; void refreshTradingState(); }
        else if (!live && hasConnected) {
            connectionEpoch++;
            for (const key of queryScopes) markStale(key, '串流曾中斷；重新連線後請手動對帳');
            publish();
        }
    };
    const stopStatus = subscribeStatusStore(statusChanged);
    import.meta.hot?.dispose(() => {
        stopMutations(); stopResponses(); stopOrders(); stopTicks(); stopStatus(); channel?.close();
        positionQuotes.forEach(entry => entry.release?.());
        if (publishTimer) clearTimeout(publishTimer);
    });
    ensureStream();
    statusChanged();
}

export const getTradingState = () => state;
export function subscribeTradingState(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
// Order actions wait for active reports. They must not fan out accounting reads.
export function tradingActionObserved() { /* reports drive the shared view */ }
export function useTradingState() {
    useEffect(start, []);
    const accounts = useAccounts();
    const current = useSyncExternalStore(subscribeTradingState, getTradingState);
    return { ...current,
        balance: current.funds?.find(f => accounts.selectedStock && accountKey(f.account) === accountKey(accounts.selectedStock))?.balance,
        margin: current.funds?.find(f => accounts.selectedFutures && accountKey(f.account) === accountKey(accounts.selectedFutures))?.margin,
    };
}
