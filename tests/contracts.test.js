import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateEvent } from "../src/contracts.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));
const sample = JSON.parse(await readFile(new URL("../data/sample.json", import.meta.url), "utf8"));

function event(overrides = {}) {
  return {
    event_id: "evt-test-001",
    event_type: "CASE_OPENED",
    aggregate_type: "repair_case",
    aggregate_id: "case-test-001",
    occurred_at: "2026-09-25T09:00:00+08:00",
    version: 1,
    payload: {},
    ...overrides,
  };
}

test("中文样例通过校验", () => {
  assert.deepEqual(validateEvent(sample, schema), []);
});

test("缺少信封字段时按稳定顺序报告", () => {
  const issues = validateEvent({}, schema);
  assert.deepEqual(issues.map((item) => item.field), issues.map((item) => item.field).toSorted());
  assert.ok(issues.some((item) => item.field === "event_id"));
});

test("时间必须带时区且版本必须为正整数", () => {
  const issues = validateEvent({ ...sample, occurred_at: "2026-09-24T12:00:00", version: 0 }, schema);
  assert.ok(issues.some((item) => item.field === "occurred_at" && item.code === "timezone_required"));
  assert.ok(issues.some((item) => item.field === "version" && item.code === "positive_integer"));
});

test("事件专属载荷不可缺失", () => {
  const issues = validateEvent({ ...sample, event_type: "PROCEDURE_AUTHORIZED", payload: {} }, schema);
  assert.ok(issues.some((item) => item.field === "payload.procedure_version" && item.code === "required"));
  assert.ok(issues.some((item) => item.field === "payload.technician_id" && item.code === "required"));
});

test("未知事件类型会被拒绝", () => {
  const issues = validateEvent({ ...sample, event_type: "UNKNOWN" }, schema);
  assert.ok(issues.some((item) => item.field === "event_type" && item.code === "unsupported_value"));
});

test("冻结工艺事件的合法载荷通过校验", () => {
  const issues = validateEvent(event({
    event_type: "PROCEDURE_FROZEN_FOR_CASE",
    payload: {
      procedure_code: "EV-BATT-REPACK",
      procedure_version: 7,
      notice_version_applied: 3,
      vehicle_config_fingerprint: "cfg-x-nl-v4",
      frozen_at: "2026-09-25T09:05:00+08:00",
    },
  }), schema);
  assert.deepEqual(issues, []);
});

test("载荷时间字段缺少时区会被报告", () => {
  const issues = validateEvent(event({
    event_type: "PROCEDURE_FROZEN_FOR_CASE",
    payload: {
      procedure_code: "EV-BATT-REPACK",
      procedure_version: 7,
      notice_version_applied: 3,
      vehicle_config_fingerprint: "cfg-x-nl-v4",
      frozen_at: "2026-09-25 09:05:00",
    },
  }), schema);
  assert.ok(issues.some((item) => item.field === "payload.frozen_at" && item.code === "timezone_required"));
});

test("公告义务事件的分群与义务枚举必须登记", () => {
  const valid = validateEvent(event({
    event_type: "SERVICE_OBLIGATION_RAISED",
    aggregate_type: "service_obligation",
    payload: {
      obligation_id: "obl-001",
      notice_version: 4,
      vehicle_cohort: "delivered",
      obligation_kind: "recall_todo",
      obligation_status: "due",
      raised_at: "2026-10-01T08:00:00+08:00",
      valid_until: "2031-10-01T08:00:00+08:00",
    },
  }), schema);
  assert.deepEqual(valid, []);

  const issues = validateEvent(event({
    event_type: "SERVICE_OBLIGATION_RAISED",
    payload: {
      obligation_id: "obl-001",
      notice_version: 4,
      vehicle_cohort: "scrap_yard",
      obligation_kind: "recall_todo",
      obligation_status: "due",
      raised_at: "2026-10-01T08:00:00+08:00",
      valid_until: "2031-10-01T08:00:00+08:00",
    },
  }), schema);
  assert.ok(issues.some((item) => item.field === "payload.vehicle_cohort" && item.code === "unsupported_value"));
});

test("重新评估不允许放弃拆检事实", () => {
  const issues = validateEvent(event({
    event_type: "CASE_REASSESSED",
    payload: {
      case_id: "case-test-001",
      reassessed_procedure_version: 8,
      disassembly_facts_retained: false,
      reassessed_at: "2026-09-25T15:00:00+08:00",
    },
  }), schema);
  assert.ok(issues.some((item) => item.field === "payload.disassembly_facts_retained" && item.code === "unsupported_value"));

  const ok = validateEvent(event({
    event_type: "CASE_REASSESSED",
    payload: {
      case_id: "case-test-001",
      reassessed_procedure_version: 8,
      disassembly_facts_retained: true,
      reassessed_at: "2026-09-25T15:00:00+08:00",
    },
  }), schema);
  assert.deepEqual(ok, []);
});

test("回执幂等重发事件合法载荷通过校验", () => {
  const issues = validateEvent(event({
    event_type: "RECEIPT_ACKNOWLEDGED",
    aggregate_type: "charge_receipt",
    payload: {
      receipt_id: "rcpt-001",
      receipt_kind: "settlement_receipt",
      case_id: "case-test-001",
      vehicle_id: "vin-092507",
      component_serial: "pack-sn-7788",
      amount: "12800.00",
      currency: "CNY",
      idempotency_key: "idem-rcpt-001",
      duplicate: true,
      acknowledged_at: "2026-09-26T11:00:00+08:00",
    },
  }), schema);
  assert.deepEqual(issues, []);
});

test("回执类型枚举越界会被拒绝", () => {
  const issues = validateEvent(event({
    event_type: "RECEIPT_ACKNOWLEDGED",
    payload: {
      receipt_id: "rcpt-001",
      receipt_kind: "verbal_quote",
      case_id: "case-test-001",
      vehicle_id: "vin-092507",
      component_serial: "pack-sn-7788",
      amount: "12800.00",
      currency: "CNY",
      idempotency_key: "idem-rcpt-001",
      duplicate: false,
      acknowledged_at: "2026-09-26T11:00:00+08:00",
    },
  }), schema);
  assert.ok(issues.some((item) => item.field === "payload.receipt_kind" && item.code === "unsupported_value"));
});

test("Schema 自洽：每个事件目录项都登记了必填载荷", () => {
  for (const eventType of schema.properties.event_type.enum) {
    const required = schema.payload_required_by_event[eventType];
    assert.ok(Array.isArray(required) && required.length > 0, `${eventType} 缺少必填载荷登记`);
  }
  for (const eventType of Object.keys(schema.payload_required_by_event)) {
    assert.ok(schema.properties.event_type.enum.includes(eventType), `${eventType} 已登记载荷但不在事件目录`);
  }
  for (const eventType of Object.keys(schema.payload_enums_by_event)) {
    assert.ok(schema.properties.event_type.enum.includes(eventType), `${eventType} 的枚举规则无对应事件`);
  }
  for (const eventType of Object.keys(schema.payload_datetime_fields_by_event)) {
    assert.ok(eventType === "*" || schema.properties.event_type.enum.includes(eventType), `${eventType} 的时间规则无对应事件`);
  }
});
