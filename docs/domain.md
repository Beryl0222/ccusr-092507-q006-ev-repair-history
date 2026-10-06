# 领域约定

记录新能源车型配置、维修授权、部件序列、技术公告、机构与技师资质、诊断证据、拆装事实、替换件来源、软件版本、质保承诺与保险案件，使跨品牌站与独立门店的维修履历可以在各自有效期内一致关联。

所有时间都必须携带时区，版本号从 1 开始递增，校验层不会替调用方改写输入。事件只追加、不覆盖；任何"更正"都以新事件表达（例如费用冲正），已经发生的拆检事实不允许抹去。

## 聚合对象

| aggregate_type | 含义 | 有效期依据 |
| --- | --- | --- |
| `vehicle_configuration` | 车型与实际装车配置（含配置指纹） | 配置指纹版本 |
| `repair_case` | 一单维修业务（接单到交付/质保） | `CASE_OPENED.valid_until` |
| `component_unit` | 带序列号的车上部件（电池包、模组、ECU 等） | 序列全生命周期 |
| `technical_notice` | 品牌技术公告与工艺版本 | `effective_from` 起至被更迭 |
| `service_organization` | 品牌站或独立维修门店 | 资质有效期（上层登记） |
| `technician` | 技师及其危险作业资质 | 资质有效期（上层登记） |
| `replacement_part` | 唯一序列号的替换件及其预留状态 | 预留 `valid_until` |
| `service_obligation` | 公告触发的车企/门店义务 | `raised_at` 至 `valid_until` |
| `diagnostic_evidence` | 诊断结论与证据包 | 永久随案保存 |
| `charge_receipt` | 诊断或结算回执 | 长期留存，可被冲正 |
| `repair_certificate` | 交付车主的脱敏维修证明 | 长期可验 |
| `insurance_claim` | 与案件关联的保险案件 | 案件有效期 |
| `warranty_coverage` | 整车/部件质保承诺 | `valid_from`–`valid_until` |

关联解析只取当前时刻落在有效区间内的记录作为"可执行授权"；过期记录不删除，仍作为历史依据供审计与祖父条款使用。

## 事件目录与业务规则

### 接单：冻结适用工艺

- `CASE_OPENED`：接单开工，载荷带 `vehicle_id`、承修 `organization_id` 与接单有效期。
- `PROCEDURE_FROZEN_FOR_CASE`：机构接单时把适用工艺冻结到案件上，固定 `procedure_code` + `procedure_version`、当时适用的 `notice_version_applied` 与实际装车的 `vehicle_config_fingerprint`。
- 冻结之后公告升级不会悄悄改变在修车的作业依据；门店凭冻结记录即可确认"下一步授权"，无需在线访问品牌工艺库。
- `PROCEDURE_AUTHORIZED`：授权层面的工艺/技师登记，载荷含 `procedure_version`、`technician_id`。

### 危险作业：双人签认与资质

- `HAZARD_STEP_SIGNED_OFF`：高压下电、电池拆包等危险步骤，必须由操作人 `operator_id` 与复核人 `verifier_id` 双人签认（业务层强制两人不同且各自具备 `qualification_code` 对应的有效资质），并回填冻结的工艺版本。
- 校验层只保证签认字段齐全；双人互斥与资质有效期由业务层在 `technician` / `service_organization` 聚合上判定。

### 配置不符：暂停受影响步骤，拆检事实保留

- `CONFIG_MISMATCH_DETECTED`：执行中发现实际配置指纹与冻结指纹不符，记录期望/实际指纹。
- `AFFECTED_STEPS_SUSPENDED`：只暂停受影响的 `step_codes`，未受影响步骤不必停工；必须给出 `reason`。
- `CASE_REASSESSED`：重新评估后冻结新工艺版本。载荷 `disassembly_facts_retained` 只接受 `true`——重新评估不改变、不删除已经完成的拆检。
- `DISASSEMBLY_RECORDED`：每一步实际拆检（哪台车、哪个序列部件、哪一步、何时）独立留痕，作为后续"到底换过哪个组件"的唯一事实来源，且只追加。

### 诊断、软件与装件

- `DIAGNOSIS_RECORDED`：故障结论代码 `fault_conclusion_code` 加证据引用列表 `evidence_refs`（数据流、测量、照片等），证据与结论同案保存。
- `SOFTWARE_FLASHED`：刷写前后软件版本（`software_version_before`/`_after`）与 ECU 序列必须成对记录，禁止只记"已升级"。
- `COMPONENT_INSTALLED`：装上的部件序列、车辆、案件与所消耗的预留 `part_reservation_id` 关联，保证替换件来源可追。

### 替换件预留：唯一、不超配

- `REPLACEMENT_PART_RESERVED`：按 `part_serial` 预留，带并发令牌 `reserve_token` 与有效期。同一序列号同时只能存在一个有效预留；并发请求超出库存或重复占用同一序列必须被业务层拒绝（不能超配）。
- `REPLACEMENT_PART_RELEASED`：预留释放或超时后，序列才可被再次预留。
- 装件事件必须引用一个有效预留，预留与装件一一对应。

### 技术公告：迟到公告的分群义务与祖父条款

- `NOTICE_ISSUED`：公告发布，含版本、影响范围 `affected_scope`、生效时间；`supersedes_notice_version` 指明取代的旧版本。
- `NOTICE_APPLIED`：案件实际适用某版本公告。
- `NOTICE_SUPERSEDED`：公告被新版本取代。
- 迟到公告到达后，业务层按公告范围扫描车辆并分别生成 `SERVICE_OBLIGATION_RAISED`：
  - `vehicle_cohort = in_repair`：仍在修的车辆，产生 `rework`（暂停/返工受影响步骤）或 `recall_todo`；
  - `delivered`：已交付车辆，产生 `recall_todo` / `notify_owner`（召回待办，重启后不得丢失）；
  - `under_warranty`：已进入质保期的车辆，产生 `warranty_entitlement`。
- 祖父条款：旧公告版本有效期间、按当时冻结工艺合法完成的维修，义务状态置为 `waived_grandfathered`，依据是案件上的 `PROCEDURE_FROZEN_FOR_CASE` 与 `NOTICE_SUPERSEDED` 记录，而不是事后删除或改写旧维修。

### 质保、证明与保险

- `WARRANTY_ISSUED`：质保承诺按案件/车辆/部件序列登记，带覆盖范围与 `valid_from`–`valid_until`；整车质保过期不影响部件级质保的独立计算。
- `REPAIR_CERTIFICATE_ISSUED`：交付车主的维修证明。`redacted` 为 `true` 时隐去工艺细则等商业信息，只保留结论、换件序列、机构与时间等可验证事实；`certificate_ref` 指向可验凭证。
- 保险案件以 `insurance_claim` 聚合参与关联，案件载荷可携带案件标识（交换层不强制），关联同样受案件有效期约束。

### 回执：完整重发只记一次，序列/金额/车辆冲突即锁定

- `RECEIPT_ACKNOWLEDGED`：诊断回执与结算回执（`receipt_kind`）均带幂等键 `idempotency_key`。
- 同一幂等键、回执内容（部件序列、金额、车辆）完全一致的完整重发：`duplicate = true`，业务层只记一次，不重复入账、不重复派件。
- 同一幂等键但部件序列、金额或车辆任一不同：不得覆盖，业务层发出 `DISPUTE_LOCKED` 锁定争议，列出冲突的案件与部件序列，待人工裁决。
- `CHARGE_REVERSED`：费用更正只能冲正——冲正事件引用原回执与冲正凭证，原回执保留，审计可从结论一路追到费用冲正。

### 服务重启：不重复派件、不丢召回待办

- `CASE_RESUMED_AFTER_RESTART`：服务恢复时对在修案件逐条续办：`redelivery_skipped_refs` 列明已派出、不得重发的替换件/工单，`pending_recall_refs` 列明仍须履行的召回义务（`service_obligation` 中状态为 `due` 的记录）。
- 派件去重以预留/装件记录为准，召回待办以义务记录为准，二者都不以"内存里是否还有任务"为准。

## 审计追溯链

审计接口沿事件链单向回溯：

```
故障结论 (DIAGNOSIS_RECORDED.fault_conclusion_code)
  └─ 证据 (evidence_refs → diagnostic_evidence)
  └─ 人员 (HAZARD_STEP_SIGNED_OFF.operator_id / verifier_id → technician)
      └─ 机构 (CASE_OPENED.organization_id → service_organization)
  └─ 部件 (DISASSEMBLY_RECORDED / COMPONENT_INSTALLED.component_serial → component_unit)
      └─ 来源 (part_reservation_id → replacement_part)
      └─ 软件 (SOFTWARE_FLASHED 版本对)
  └─ 工艺依据 (PROCEDURE_FROZEN_FOR_CASE → NOTICE_APPLIED / NOTICE_SUPERSEDED)
  └─ 费用 (charge_receipt → CHARGE_REVERSED 冲正链)
  └─ 后续 (WARRANTY_ISSUED / REPAIR_CERTIFICATE_ISSUED / service_obligation)
```

车主侧只能看到 `redacted` 证明视图；门店侧能看到冻结工艺与下一步授权；审计侧可见全链。

## 事件必填载荷速查

- `PROCEDURE_AUTHORIZED`：`procedure_version`, `technician_id`。
- `PROCEDURE_FROZEN_FOR_CASE`：`procedure_code`, `procedure_version`, `notice_version_applied`, `vehicle_config_fingerprint`, `frozen_at`。
- `HAZARD_STEP_SIGNED_OFF`：`case_id`, `step_code`, `procedure_code`, `procedure_version`, `operator_id`, `verifier_id`, `qualification_code`, `signed_at`。
- `CONFIG_MISMATCH_DETECTED` / `AFFECTED_STEPS_SUSPENDED` / `CASE_REASSESSED`：案件、步骤、期望/实际指纹与各环节时间；重评估必须带 `disassembly_facts_retained`。
- `DIAGNOSIS_RECORDED`：`case_id`, `vehicle_id`, `fault_conclusion_code`, `evidence_refs`, `diagnosed_at`。
- `DISASSEMBLY_RECORDED`：`case_id`, `step_code`, `component_serial`, `vehicle_id`, `disassembled_at`。
- `SOFTWARE_FLASHED`：`case_id`, `vehicle_id`, `ecu_serial`, `software_version_before`, `software_version_after`, `flashed_at`。
- `COMPONENT_INSTALLED`：`component_serial`, `vehicle_id`, `case_id`, `part_reservation_id`, `installed_at`。
- `REPLACEMENT_PART_RESERVED`：`reservation_id`, `part_serial`, `case_id`, `reserve_token`, `reserved_at`, `valid_until`；释放事件对应 `released_at`。
- `NOTICE_ISSUED`：`notice_code`, `notice_version`, `affected_scope`, `effective_from`, `supersedes_notice_version`（首个公告无旧版本时为 `null`，字段仍须出现）；`NOTICE_APPLIED` 另需 `case_id`, `applied_at`；`NOTICE_SUPERSEDED` 需新旧版本与时间。
- `SERVICE_OBLIGATION_RAISED`：`obligation_id`, `notice_version`, `vehicle_cohort`, `obligation_kind`, `obligation_status`, `raised_at`, `valid_until`。
- `WARRANTY_ISSUED`：`case_id`, `vehicle_id`, `component_serial`, `coverage_scope`, `valid_from`, `valid_until`。
- `REPAIR_CERTIFICATE_ISSUED`：`case_id`, `vehicle_id`, `certificate_ref`, `redacted`, `issued_at`。
- `RECEIPT_ACKNOWLEDGED`：`receipt_id`, `receipt_kind`, `case_id`, `vehicle_id`, `component_serial`, `amount`, `currency`, `idempotency_key`, `duplicate`, `acknowledged_at`。
- `CHARGE_REVERSED`：`receipt_id`, `case_id`, `reversal_ref`, `reversed_at`。
- `DISPUTE_LOCKED`：`idempotency_key`, `case_ids`, `part_serials`, `locked_at`。
- `CASE_RESUMED_AFTER_RESTART`：`case_id`, `resumed_at`, `redelivery_skipped_refs`, `pending_recall_refs`。

所有载荷时间字段（`*_at`、`valid_from`、`valid_until`、`effective_from`）同样必须显式携带时区。

## 校验边界

交换层负责：信封结构、枚举登记（含 `vehicle_cohort`、`obligation_kind`、`obligation_status`、`receipt_kind`、`duplicate`、`redacted`、`disassembly_facts_retained`）、时间时区、版本与必填载荷。

以下属于上层业务服务职责，交换层不实现但已为其登记判定字段：幂等去重与争议锁定、替换件唯一预留与超配拦截、双人签认互斥与资质有效期、有效期区间关联、公告分群义务生成、祖父条款认定、脱敏视图、重启恢复编排。
