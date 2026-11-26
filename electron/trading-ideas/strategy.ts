import type { IdeaContent } from '../../src/shared/trading-ideas'

const finance =
  /A\s*股|ETF|指数|行业|板块|股票|组合|股指|证券|市场|\b(?:stocks?|equity|equities|ETF|ETFs|portfolios?|sectors?|assets?|markets?|trading|returns?)\b/iu

const technique =
  /轮动|多因子|选股|择时|回测|动量|反转|均值回归|配对交易|统计套利|风险平价|组合优化|资产配置|调仓规则|交易信号|仓位规则|进出场|止盈止损|流动性因子|量价信号|套期保值|对冲策略|\b(?:momentum|mean[- ]reversion|reversal|sector rotation|factor[- ](?:investing|model|strategy)|multi[- ]factor|size and value|stock selection|market timing|risk parity|asset allocation|pairs trading|statistical arbitrage|portfolio (?:construction|selection|optimization|optimisation|choice|rebalancing)|trading (?:rules?|signals?|strateg(?:y|ies))|backtest(?:ing|s)?|hedging|optimal execution|price impact)\b/iu

const hypothesis =
  /预测|领先指标|相关性|超额收益|样本外|入场|买入条件|卖出条件|收益差异|是否.*(?:延续|反转|有效|跑赢)|\b(?:predict(?:s|ive|ability)?|out-of-sample|excess returns?|return predictability)\b/iu
const tradingInput =
  /资金流|份额|申赎|成交量|成交额|换手率|折溢价|拥挤度|价差|估值|波动率|流动性|交易成本|\b(?:fund flows?|volatility|liquidity|valuation|turnover|volume|spreads?|transaction costs?)\b/iu

export function isStrategyIdea(item: Pick<IdeaContent, 'category' | 'title' | 'summary'>) {
  if (
    item.category !== '论文' &&
    item.category !== '公开社区与开源' &&
    item.category !== '未证实传闻'
  )
    return false
  const text = item.title + ' ' + item.summary
  return (
    finance.test(text) &&
    (technique.test(text) || (tradingInput.test(text) && hypothesis.test(text)))
  )
}
