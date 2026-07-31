# 运营待办工作台

`/api/ops` 是全托 BI 的只读运营优先事项查询面。它把采购、交付、库存、
备货、商品身份、平台事件和数据质量问题统一成可分页的工作清单，但不创建
SHEIN 写请求，也不把“建议查看”解释成已执行动作。

## 数据口径

- 采购单：`supply.purchaseOrderAttention`
- 交付入仓：`supply.deliveryAttention`
- 库存与缺货：`supply.inventoryRisks`
- 备货建议与急采：`supply.stockAdviceRisks`
- 其他系统项：只用 `actionPool.candidates` 补充上述明细没有覆盖的类型
- 商品身份、销量质量、Webhook 运行异常：使用 Dashboard 中对应的聚合事实

四类业务明细分别返回 `returned / total / truncated`。候选池即使截断，也不能
覆盖或改变完整业务明细的统计口径。未知值保持未知，不补零。

## 查询合同

允许的参数只有：

`owner`、`store`、`q`、`view`、`severity`、`domain`、`quick`、`sort`、
`page`、`pageSize`。

其中：

- `view`: `PRIORITY | ALL`
- `severity`: `ALL | CRITICAL | HIGH | MEDIUM | LOW`
- `domain`: `ALL | PROCUREMENT | FULFILMENT | INVENTORY | SUPPLY | PRODUCTS |
  PLATFORM | SYSTEM | OTHER`
- `quick`: `ALL | HIGH | OVERDUE | SHORTAGE | URGENT | SYNC`
- `sort`: `PRIORITY | LATEST | DEADLINE | STORE`
- `pageSize`: `25 | 50 | 100`

未知参数、重复参数、越界页码和未列入白名单的枚举值均返回 `400`。接口只接受
`GET`/`HEAD`，返回 `readOnly: true`。

## 页面行为

- 总览和两组排行使用当前负责人/店铺范围的完整已物化事实。
- 本地严重度、业务类型、快捷筛查、关键词和排序由服务端执行。
- 浏览器只接收当前页，不再一次性渲染数百条运营风险。
- 清单行下钻到采购、交付、库存、商品、平台或系统健康页；所有筛选状态写入
  可分享的 URL。
- 自动化状态目前为 `observe_only`，`writeEnabled=false`。未来接入 CLI 时，
  仍须保留计划、确认、执行和回读边界，不能从本页直接绕过。
