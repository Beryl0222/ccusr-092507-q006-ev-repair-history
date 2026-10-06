# 领域约定

记录新能源车型、维修授权、部件序列和处置事实，为跨机构维修履历提供一致契约。

聚合对象包括`vehicle_configuration`、`repair_case`、`component_unit`、`technical_notice`。事件类型包括`CASE_OPENED`、`PROCEDURE_AUTHORIZED`、`COMPONENT_INSTALLED`、`NOTICE_APPLIED`、`WARRANTY_ISSUED`。所有时间都必须携带时区，版本号从 1 开始递增，校验层不会替调用方改写输入。

## 事件载荷

- `PROCEDURE_AUTHORIZED`：还需包含 `procedure_version`, `technician_id`。
- `COMPONENT_INSTALLED`：还需包含 `component_serial`, `vehicle_id`。
- `NOTICE_APPLIED`：还需包含 `notice_version`, `affected_scope`。

同一事件标识的幂等与冲突处理属于上层业务服务职责；交换层只负责稳定报告结构、枚举、时间、版本和必需载荷问题。

## 业务服务（src/service.js）

`RepairHistoryService` 以事件溯源实现履历：所有状态变更先过契约校验再追加到事件日志（可选 JSONL 文件持久化），内存投影完全由重放得到。

- 基础资料：`registerVehicle` / `registerTechnician` / `registerComponent` 登记车型配置（含软件版本）、机构技师资质（含有效期）与唯一替换件（序列不可重复登记）。
- 接单冻结：`openCase` 按接单时刻有效的技术公告冻结适用工艺版本；之后公告升级不影响在修案件，新案件按新公告冻结。
- 危险操作：`signOffStep` 对危险步骤强制两名不同技师签认，且签认人必须持有有效资质；资质过期或缺失即拒绝。
- 配置不符：`reportConfigMismatch` 暂停受影响步骤并记录拆检事实，`reevaluateCase` 重新冻结工艺后步骤回到待执行，已拆检事实与已完成步骤不抹去。
- 迟到公告：`publishNotice` 对影响范围内仍在修的车辆生成 `stop_and_reevaluate`（暂停案件）、对已交付的生成 `customer_notification`、对质保期内的生成 `warranty_recall`；旧公告下完成的合法维修在 `auditTrace` 的 `legal_basis` 中保留依据。
- 回执幂等：`submitReceipt` 对同一回执序列的完整重发只记一次；序列相同而零件、金额或车辆不同则触发 `DISPUTE_LOCKED` 锁定案件。`correctFee` 以独立冲正事件挂接原结算回执。
- 替换件：`reserveComponent` 保证唯一替换件不被超配，`installComponent` 只允许装到预留案件的车辆上。
- 视图：`ownerCertificate` 给车主不含商业工艺细节的维修证明；`nextAuthorization` 让门店确认下一步授权与签认要求；`auditTrace` 从故障结论追到证据、人员、部件与费用冲正。
- 重启恢复：义务与派件均为事件，重启重放后 `pendingDispatches` 不重复派件、`pendingObligations` 不丢失召回待办。
