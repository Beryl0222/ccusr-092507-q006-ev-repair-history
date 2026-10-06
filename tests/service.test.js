import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RepairHistoryService } from "../src/service.js";

const schema = JSON.parse(await readFile(new URL("../contracts/domain.schema.json", import.meta.url), "utf8"));

const T = (time, day = "01") => `2026-03-${day}T${time}:00+08:00`;

const PROCEDURE_V1 = {
  steps: [
    { step_id: "teardown", name: "电池包拆解", dangerous: true, requires_qualification: "high_voltage", detail: "商业工艺: 母排断开顺序" },
    { step_id: "swap", name: "模组更换", dangerous: false },
  ],
};

function setup() {
  const service = new RepairHistoryService({ schema });
  for (const id of ["V1", "V2", "V3"]) {
    service.registerVehicle({ vehicle_id: id, model: "EV-X", software_version: "1.2.0", at: T("08:00") });
  }
  for (const id of ["T1", "T2"]) {
    service.registerTechnician({
      technician_id: id,
      shop_id: "S1",
      qualifications: [{ code: "high_voltage", valid_until: "2027-01-01T00:00:00+08:00" }],
      at: T("08:05"),
    });
  }
  service.registerTechnician({ technician_id: "T3", shop_id: "S1", qualifications: [], at: T("08:06") });
  service.publishNotice({
    notice_id: "N1",
    notice_version: "1",
    affected_scope: { models: ["EV-X"] },
    effective_from: "2026-01-01T00:00:00+08:00",
    procedure: PROCEDURE_V1,
    published_at: "2026-01-01T09:00:00+08:00",
  });
  return service;
}

function finishCase(service, caseId, vehicleId, at) {
  service.openCase({ case_id: caseId, vehicle_id: vehicleId, shop_id: "S1", technician_id: "T1", at });
  service.signOffStep({ case_id: caseId, step_id: "teardown", technician_ids: ["T1", "T2"], at });
  service.signOffStep({ case_id: caseId, step_id: "swap", technician_ids: ["T1"], at });
  service.deliverCase({ case_id: caseId, at });
}

test("接单时冻结适用工艺，后续公告不影响在修案件", () => {
  const service = setup();
  service.openCase({ case_id: "C1", vehicle_id: "V1", shop_id: "S1", technician_id: "T1", at: T("09:00") });
  assert.equal(service.caseSnapshot("C1").procedure_version, "N1@1");
  service.publishNotice({
    notice_id: "N1",
    notice_version: "2",
    affected_scope: { models: ["EV-X"] },
    effective_from: T("09:30"),
    procedure: { steps: [{ step_id: "other", name: "其他步骤", dangerous: false }] },
    published_at: T("09:30"),
  });
  const snapshot = service.caseSnapshot("C1");
  assert.equal(snapshot.procedure_version, "N1@1");
  assert.deepEqual(snapshot.steps.map((step) => step.step_id), ["teardown", "swap"]);
  // 新案件按新公告冻结
  service.openCase({ case_id: "C2", vehicle_id: "V2", shop_id: "S1", technician_id: "T1", at: T("10:00") });
  assert.equal(service.caseSnapshot("C2").procedure_version, "N1@2");
});

test("危险操作必须双人签认且资质有效", () => {
  const service = setup();
  service.openCase({ case_id: "C1", vehicle_id: "V1", shop_id: "S1", technician_id: "T1", at: T("09:00") });
  assert.throws(() => service.signOffStep({ case_id: "C1", step_id: "teardown", technician_ids: ["T1"], at: T("09:10") }), /双人签认/);
  assert.throws(() => service.signOffStep({ case_id: "C1", step_id: "teardown", technician_ids: ["T1", "T1"], at: T("09:10") }), /双人签认/);
  assert.throws(() => service.signOffStep({ case_id: "C1", step_id: "teardown", technician_ids: ["T1", "T3"], at: T("09:10") }), /缺少资质/);
  service.registerTechnician({
    technician_id: "T4",
    shop_id: "S1",
    qualifications: [{ code: "high_voltage", valid_until: "2026-01-01T00:00:00+08:00" }],
    at: T("09:05"),
  });
  assert.throws(() => service.signOffStep({ case_id: "C1", step_id: "teardown", technician_ids: ["T1", "T4"], at: T("09:10") }), /已过期/);
  service.signOffStep({ case_id: "C1", step_id: "teardown", technician_ids: ["T1", "T2"], at: T("09:10") });
  assert.equal(service.caseSnapshot("C1").steps.find((step) => step.step_id === "teardown").status, "done");
  // 普通步骤单人即可
  service.signOffStep({ case_id: "C1", step_id: "swap", technician_ids: ["T1"], at: T("09:20") });
  assert.equal(service.nextAuthorization("C1").next, "deliver");
});

test("配置不符暂停受影响步骤并重新评估，已拆检事实保留", () => {
  const service = setup();
  service.openCase({ case_id: "C1", vehicle_id: "V1", shop_id: "S1", technician_id: "T1", at: T("09:00") });
  service.reportConfigMismatch({
    case_id: "C1",
    step_id: "teardown",
    expected: { module: "M8" },
    found: { module: "M6", note: "已断开母排并拆下上盖" },
    at: T("09:30"),
  });
  assert.equal(service.caseSnapshot("C1").status, "paused");
  assert.throws(() => service.signOffStep({ case_id: "C1", step_id: "teardown", technician_ids: ["T1", "T2"], at: T("09:40") }), /暂停/);
  service.reevaluateCase({ case_id: "C1", technician_id: "T1", at: T("10:00") });
  const snapshot = service.caseSnapshot("C1");
  assert.equal(snapshot.status, "in_progress");
  const teardown = snapshot.steps.find((step) => step.step_id === "teardown");
  assert.equal(teardown.status, "pending");
  assert.equal(teardown.facts.length, 1);
  assert.equal(teardown.facts[0].found.note, "已断开母排并拆下上盖");
  const audit = service.auditTrace("C1");
  assert.ok(audit.evidence.some((item) => item.type === "config_mismatch" && item.found.module === "M6"));
});

test("迟到公告对在修、已交付、在保车辆生成不同义务，旧公告依据保留", () => {
  const service = setup();
  service.openCase({ case_id: "C1", vehicle_id: "V1", shop_id: "S1", technician_id: "T1", at: T("09:00") });
  finishCase(service, "C2", "V2", T("09:00"));
  finishCase(service, "C3", "V3", T("09:00"));
  service.issueWarranty({ case_id: "C3", warranty_id: "W3", coverage_until: "2027-06-01T00:00:00+08:00", commitment: "电池整包 8 年质保", at: T("09:30") });

  const raised = service.publishNotice({
    notice_id: "N2",
    notice_version: "1",
    affected_scope: { models: ["EV-X"] },
    effective_from: "2026-02-01T00:00:00+08:00",
    procedure: { steps: [{ step_id: "recheck", name: "复检", dangerous: false }] },
    published_at: T("11:00"),
  });
  const byType = Object.fromEntries(raised.map((item) => [item.type, item]));
  assert.equal(byType.stop_and_reevaluate.case_id, "C1");
  assert.equal(byType.customer_notification.case_id, "C2");
  assert.equal(byType.warranty_recall.case_id, "C3");
  assert.equal(service.caseSnapshot("C1").status, "paused");
  assert.deepEqual(service.pendingDispatches().map((item) => item.obligation_id).toSorted(), raised.map((item) => item.obligation_id).toSorted());
  // 旧公告下完成的合法维修保留依据
  const basis = service.auditTrace("C2").legal_basis;
  assert.ok(basis.some((item) => item.procedure_version === "N1@1"));
});

test("同一回执完整重发只记一次，内容不同则锁定争议", () => {
  const service = setup();
  service.openCase({ case_id: "C1", vehicle_id: "V1", shop_id: "S1", technician_id: "T1", at: T("09:00") });
  const receipt = { receipt_id: "R1", kind: "diagnostic", case_id: "C1", vehicle_id: "V1", conclusion: "电池模组衰减", at: T("09:10") };
  assert.deepEqual(service.submitReceipt(receipt), { recorded: true });
  assert.deepEqual(service.submitReceipt(receipt), { recorded: false, duplicate: true });
  assert.equal(service.log.filter((event) => event.event_type === "DIAGNOSTIC_RECORDED").length, 1);

  const conflict = service.submitReceipt({ ...receipt, conclusion: "BMS 故障" });
  assert.deepEqual(conflict, { recorded: false, dispute: true });
  assert.equal(service.caseSnapshot("C1").dispute_locked, true);
  assert.equal(service.nextAuthorization("C1").blocked, true);
  assert.throws(() => service.signOffStep({ case_id: "C1", step_id: "teardown", technician_ids: ["T1", "T2"], at: T("09:20") }), /争议/);

  const other = setup();
  other.openCase({ case_id: "C1", vehicle_id: "V1", shop_id: "S1", technician_id: "T1", at: T("09:00") });
  const settlement = { receipt_id: "R9", kind: "settlement", case_id: "C1", vehicle_id: "V1", amount: 12000, at: T("09:10") };
  other.submitReceipt(settlement);
  assert.deepEqual(other.submitReceipt({ ...settlement, amount: 9000 }).dispute, true);
});

test("唯一替换件预留不能超配，安装必须对应预留案件", () => {
  const service = setup();
  service.openCase({ case_id: "C1", vehicle_id: "V1", shop_id: "S1", technician_id: "T1", at: T("09:00") });
  service.openCase({ case_id: "C2", vehicle_id: "V2", shop_id: "S1", technician_id: "T1", at: T("09:00") });
  service.registerComponent({ component_serial: "P1", part_number: "BM-01", source: "品牌原厂", at: T("09:01") });
  assert.throws(() => service.registerComponent({ component_serial: "P1", part_number: "BM-01", source: "拆车件", at: T("09:02") }), /唯一/);
  service.reserveComponent({ case_id: "C1", component_serial: "P1", at: T("09:05") });
  assert.throws(() => service.reserveComponent({ case_id: "C2", component_serial: "P1", at: T("09:06") }), /超配/);
  assert.throws(() => service.installComponent({ case_id: "C2", component_serial: "P1", at: T("09:07") }), /未预留/);
  service.installComponent({ case_id: "C1", component_serial: "P1", at: T("09:08") });
  assert.equal(service.auditTrace("C1").parts.installed[0], "P1");
});

test("车主维修证明不含商业工艺细节", () => {
  const service = setup();
  service.registerComponent({ component_serial: "P1", part_number: "BM-01", source: "品牌原厂", at: T("08:30") });
  service.openCase({ case_id: "C1", vehicle_id: "V1", shop_id: "S1", technician_id: "T1", at: T("09:00") });
  service.reserveComponent({ case_id: "C1", component_serial: "P1", at: T("09:05") });
  service.installComponent({ case_id: "C1", component_serial: "P1", at: T("09:06") });
  service.signOffStep({ case_id: "C1", step_id: "teardown", technician_ids: ["T1", "T2"], at: T("09:10") });
  service.signOffStep({ case_id: "C1", step_id: "swap", technician_ids: ["T1"], at: T("09:20") });
  service.deliverCase({ case_id: "C1", at: T("09:30") });
  service.issueWarranty({ case_id: "C1", warranty_id: "W1", coverage_until: "2028-03-01T00:00:00+08:00", commitment: "电池整包 2 年质保", at: T("09:31") });

  const certificate = service.ownerCertificate("C1");
  assert.equal(certificate.parts[0].component_serial, "P1");
  assert.equal(certificate.warranty.warranty_id, "W1");
  assert.equal(certificate.authorized_procedure_version, "N1@1");
  assert.ok(!("steps" in certificate));
  assert.ok(!JSON.stringify(certificate).includes("商业工艺"));
});

test("审计接口从故障结论追到证据、人员、部件与费用冲正", () => {
  const service = setup();
  service.openCase({ case_id: "C1", vehicle_id: "V1", shop_id: "S1", technician_id: "T1", at: T("09:00") });
  service.submitReceipt({ receipt_id: "R1", kind: "diagnostic", case_id: "C1", vehicle_id: "V1", conclusion: "电池模组衰减", at: T("09:05") });
  service.registerComponent({ component_serial: "P1", part_number: "BM-01", source: "品牌原厂", at: T("09:06") });
  service.reserveComponent({ case_id: "C1", component_serial: "P1", at: T("09:07") });
  service.installComponent({ case_id: "C1", component_serial: "P1", at: T("09:08") });
  service.signOffStep({ case_id: "C1", step_id: "teardown", technician_ids: ["T1", "T2"], at: T("09:10") });
  service.submitReceipt({ receipt_id: "R2", kind: "settlement", case_id: "C1", vehicle_id: "V1", amount: 12000, at: T("09:20") });
  service.correctFee({ case_id: "C1", original_receipt_id: "R2", correction_id: "FC1", amount_delta: -2000, reason: "工时冲正", at: T("09:25") });

  const audit = service.auditTrace("C1");
  assert.equal(audit.conclusion, "电池模组衰减");
  assert.ok(audit.evidence.some((item) => item.receipt_id === "R1"));
  assert.deepEqual(audit.personnel.signoffs.teardown, ["T1", "T2"]);
  assert.ok(audit.personnel.authorizers.includes("T1"));
  assert.deepEqual(audit.parts.installed, ["P1"]);
  assert.equal(audit.fees.settlements[0].amount, 12000);
  assert.deepEqual(audit.fees.corrections, [{ correction_id: "FC1", original_receipt_id: "R2", amount_delta: -2000, reason: "工时冲正" }]);
});

test("服务重启后不重复派件也不丢失召回待办", () => {
  const dir = mkdtempSync(join(tmpdir(), "ev-repair-"));
  const path = join(dir, "events.jsonl");

  const first = new RepairHistoryService({ schema, persistPath: path });
  first.registerVehicle({ vehicle_id: "V1", model: "EV-X", software_version: "1.2.0", at: T("08:00") });
  first.registerTechnician({ technician_id: "T1", shop_id: "S1", qualifications: [{ code: "high_voltage" }], at: T("08:05") });
  first.openCase({ case_id: "C1", vehicle_id: "V1", shop_id: "S1", technician_id: "T1", at: T("09:00") });
  const raised = first.publishNotice({
    notice_id: "N2",
    notice_version: "1",
    affected_scope: { models: ["EV-X"] },
    effective_from: "2026-02-01T00:00:00+08:00",
    published_at: T("11:00"),
  });
  assert.equal(first.pendingDispatches().length, 1);
  first.recordDispatch({ obligation_id: raised[0].obligation_id, channel: "sms", at: T("11:05") });

  const restored = new RepairHistoryService({ schema, persistPath: path });
  assert.equal(restored.pendingDispatches().length, 0);
  assert.equal(restored.pendingObligations().length, 1);
  assert.equal(restored.caseSnapshot("C1").status, "paused");
  assert.deepEqual(restored.recordDispatch({ obligation_id: raised[0].obligation_id, channel: "sms", at: T("11:06") }), { dispatched: false, duplicate: true });
  assert.equal(restored.log.filter((event) => event.event_type === "DISPATCH_RECORDED").length, 1);
});
