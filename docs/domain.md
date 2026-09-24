# 领域约定

记录新能源车型、维修授权、部件序列和处置事实，为跨机构维修履历提供一致契约。

聚合对象包括`vehicle_configuration`、`repair_case`、`component_unit`、`technical_notice`。事件类型包括`CASE_OPENED`、`PROCEDURE_AUTHORIZED`、`COMPONENT_INSTALLED`、`NOTICE_APPLIED`、`WARRANTY_ISSUED`。所有时间都必须携带时区，版本号从 1 开始递增，校验层不会替调用方改写输入。

## 事件载荷

- `PROCEDURE_AUTHORIZED`：还需包含 `procedure_version`, `technician_id`。
- `COMPONENT_INSTALLED`：还需包含 `component_serial`, `vehicle_id`。
- `NOTICE_APPLIED`：还需包含 `notice_version`, `affected_scope`。

同一事件标识的幂等与冲突处理属于上层业务服务职责；交换层只负责稳定报告结构、枚举、时间、版本和必需载荷问题。
