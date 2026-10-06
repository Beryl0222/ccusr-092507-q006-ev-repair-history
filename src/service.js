import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

import { validateEvent } from "./contracts.js";

const DEFAULT_DANGEROUS_QUALIFICATION = "high_voltage";

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

/**
 * 新能源维修授权履历业务服务。
 *
 * 所有状态变更以领域事件追加到日志（可选 JSONL 文件持久化），
 * 内存投影完全由事件重放得到，因此服务重启后不重复派件、不丢失召回待办。
 * 事件落库前一律经过契约校验，校验层不改写输入。
 */
export class RepairHistoryService {
  constructor({ schema, persistPath = null } = {}) {
    if (!schema) throw new Error("缺少领域契约 schema");
    this.schema = schema;
    this.persistPath = persistPath;
    this.log = [];
    this.eventIds = new Set();
    this.versions = new Map();
    this.vehicles = new Map();
    this.technicians = new Map();
    this.components = new Map();
    this.notices = new Map();
    this.cases = new Map();
    this.receipts = new Map();
    this.obligations = new Map();
    this.sequence = 0;
    if (persistPath && existsSync(persistPath)) {
      const lines = readFileSync(persistPath, "utf8").split("\n").filter((line) => line.trim() !== "");
      for (const line of lines) this.#replay(JSON.parse(line));
    }
  }

  // ---------- 事件基座 ----------

  #replay(event) {
    if (this.eventIds.has(event.event_id)) return;
    this.eventIds.add(event.event_id);
    this.log.push(event);
    const key = `${event.aggregate_type}:${event.aggregate_id}`;
    this.versions.set(key, Math.max(this.versions.get(key) ?? 0, event.version));
    this.sequence += 1;
    this.#apply(event);
  }

  #emit(eventType, aggregateType, aggregateId, payload, occurredAt) {
    const key = `${aggregateType}:${aggregateId}`;
    const event = {
      event_id: `evt-${this.sequence + 1}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: occurredAt,
      version: (this.versions.get(key) ?? 0) + 1,
      payload,
    };
    const issues = validateEvent(event, this.schema);
    if (issues.length > 0) {
      throw new Error(`事件未通过契约校验: ${issues.map((issue) => `${issue.field}:${issue.code}`).join(", ")}`);
    }
    if (this.persistPath) appendFileSync(this.persistPath, `${JSON.stringify(event)}\n`, "utf8");
    this.#replay(event);
    return event;
  }

  #apply(event) {
    const p = event.payload;
    switch (event.event_type) {
      case "CONFIG_REGISTERED":
        this.vehicles.set(p.vehicle_id, {
          vehicle_id: p.vehicle_id,
          model: p.model,
          software_version: p.software_version,
          components: [...(p.components ?? [])],
        });
        break;
      case "TECHNICIAN_REGISTERED":
        this.technicians.set(p.technician_id, {
          technician_id: p.technician_id,
          shop_id: p.shop_id,
          qualifications: clone(p.qualifications),
        });
        break;
      case "COMPONENT_STOCKED":
        this.components.set(p.component_serial, {
          component_serial: p.component_serial,
          part_number: p.part_number,
          source: p.source,
          status: "available",
          case_id: null,
          vehicle_id: null,
        });
        break;
      case "CASE_OPENED":
        this.cases.set(p.case_id, {
          case_id: p.case_id,
          vehicle_id: p.vehicle_id,
          shop_id: p.shop_id,
          status: "open",
          procedure: null,
          procedure_history: [],
          steps: new Map(),
          reevaluation_pending: false,
          dispute_locked: false,
          opened_at: event.occurred_at,
          delivered_at: null,
          warranty: null,
          diagnostics: [],
          settlements: [],
          corrections: [],
        });
        break;
      case "PROCEDURE_AUTHORIZED": {
        const c = this.cases.get(p.case_id);
        if (c.procedure) c.procedure_history.push(c.procedure);
        c.procedure = {
          notice_id: p.notice_id ?? null,
          notice_version: p.notice_version ?? null,
          procedure_version: p.procedure_version,
          authorized_by: p.technician_id,
          steps: clone(p.steps ?? []),
        };
        for (const step of c.procedure.steps) {
          if (!c.steps.has(step.step_id)) c.steps.set(step.step_id, { status: "pending", signoffs: [], facts: [] });
        }
        // 重新评估后受影响步骤回到待执行，已拆检事实保留
        for (const record of c.steps.values()) {
          if (record.status === "paused") record.status = "pending";
        }
        c.reevaluation_pending = false;
        if (c.status === "paused") c.status = "in_progress";
        break;
      }
      case "STEP_SIGNED_OFF": {
        const c = this.cases.get(p.case_id);
        const record = c.steps.get(p.step_id);
        record.status = "done";
        record.signoffs = [...p.technician_ids];
        c.status = "in_progress";
        break;
      }
      case "CONFIG_MISMATCH_DETECTED": {
        const c = this.cases.get(p.case_id);
        const record = c.steps.get(p.step_id);
        record.facts.push({ expected: clone(p.expected), found: clone(p.found), recorded_at: event.occurred_at });
        record.status = "paused";
        c.status = "paused";
        c.reevaluation_pending = true;
        break;
      }
      case "COMPONENT_RESERVED": {
        const comp = this.components.get(p.component_serial);
        comp.status = "reserved";
        comp.case_id = p.case_id;
        break;
      }
      case "COMPONENT_INSTALLED": {
        const comp = this.components.get(p.component_serial);
        comp.status = "installed";
        comp.vehicle_id = p.vehicle_id;
        this.vehicles.get(p.vehicle_id)?.components.push(p.component_serial);
        break;
      }
      case "NOTICE_PUBLISHED": {
        const versions = this.notices.get(p.notice_id) ?? [];
        versions.push({
          notice_id: p.notice_id,
          notice_version: p.notice_version,
          affected_scope: clone(p.affected_scope),
          effective_from: p.effective_from,
          effective_to: p.effective_to ?? null,
          procedure: clone(p.procedure ?? { steps: [] }),
          published_at: event.occurred_at,
        });
        this.notices.set(p.notice_id, versions);
        break;
      }
      case "OBLIGATION_RAISED":
        this.obligations.set(p.obligation_id, {
          obligation_id: p.obligation_id,
          type: p.obligation_type,
          vehicle_id: p.vehicle_id,
          case_id: p.case_id ?? null,
          notice_id: p.notice_id,
          dedupe_key: p.dedupe_key,
          status: "pending",
          dispatched: false,
          raised_at: event.occurred_at,
        });
        if (p.obligation_type === "stop_and_reevaluate" && p.case_id) {
          const c = this.cases.get(p.case_id);
          c.status = "paused";
          c.reevaluation_pending = true;
        }
        break;
      case "DIAGNOSTIC_RECORDED": {
        const entry = { kind: "diagnostic", content: clone(p), recorded_at: event.occurred_at, corrections: [] };
        this.receipts.set(p.receipt_id, entry);
        this.cases.get(p.case_id)?.diagnostics.push(entry);
        break;
      }
      case "SETTLEMENT_RECORDED": {
        const entry = { kind: "settlement", content: clone(p), recorded_at: event.occurred_at, corrections: [] };
        this.receipts.set(p.receipt_id, entry);
        this.cases.get(p.case_id)?.settlements.push(entry);
        break;
      }
      case "FEE_CORRECTED": {
        const correction = { ...clone(p), recorded_at: event.occurred_at };
        this.receipts.get(p.original_receipt_id)?.corrections.push(correction);
        this.cases.get(p.case_id)?.corrections.push(correction);
        break;
      }
      case "DISPUTE_LOCKED": {
        const c = this.cases.get(p.case_id);
        if (c) c.dispute_locked = true;
        break;
      }
      case "CASE_DELIVERED": {
        const c = this.cases.get(p.case_id);
        c.status = "delivered";
        c.delivered_at = event.occurred_at;
        break;
      }
      case "WARRANTY_ISSUED": {
        const c = this.cases.get(p.case_id);
        c.warranty = { warranty_id: p.warranty_id, coverage_until: p.coverage_until, commitment: p.commitment ?? null };
        break;
      }
      case "DISPATCH_RECORDED": {
        const obligation = this.obligations.get(p.obligation_id);
        if (obligation) obligation.dispatched = true;
        break;
      }
      default:
        break;
    }
  }

  #requireCase(caseId) {
    const c = this.cases.get(caseId);
    if (!c) throw new Error(`维修案件 ${caseId} 不存在`);
    return c;
  }

  #inScope(vehicle, scope) {
    return Boolean(
      scope?.vehicle_ids?.includes(vehicle.vehicle_id) || scope?.models?.includes(vehicle.model),
    );
  }

  #applicableNotice(vehicle, at) {
    let best = null;
    for (const versions of this.notices.values()) {
      for (const notice of versions) {
        if (!this.#inScope(vehicle, notice.affected_scope)) continue;
        if (Date.parse(notice.effective_from) > Date.parse(at)) continue;
        if (notice.effective_to && Date.parse(notice.effective_to) < Date.parse(at)) continue;
        if (!best || notice.notice_version.localeCompare(best.notice_version, undefined, { numeric: true }) > 0) {
          best = notice;
        }
      }
    }
    return best;
  }

  #assertQualified(technicianId, qualification, at) {
    const tech = this.technicians.get(technicianId);
    if (!tech) throw new Error(`技师 ${technicianId} 未登记`);
    const held = (tech.qualifications ?? []).find((item) => item.code === qualification);
    if (!held) throw new Error(`技师 ${technicianId} 缺少资质 ${qualification}`);
    if (held.valid_until && Date.parse(held.valid_until) < Date.parse(at)) {
      throw new Error(`技师 ${technicianId} 资质 ${qualification} 已过期`);
    }
  }

  // ---------- 基础资料登记 ----------

  registerVehicle({ vehicle_id, model, software_version, components = [], at }) {
    this.#emit("CONFIG_REGISTERED", "vehicle_configuration", vehicle_id, { vehicle_id, model, software_version, components }, at);
  }

  registerTechnician({ technician_id, shop_id, qualifications, at }) {
    this.#emit("TECHNICIAN_REGISTERED", "technician", technician_id, { technician_id, shop_id, qualifications }, at);
  }

  registerComponent({ component_serial, part_number, source, at }) {
    if (this.components.has(component_serial)) throw new Error(`替换件 ${component_serial} 已登记，序列必须唯一`);
    this.#emit("COMPONENT_STOCKED", "component_unit", component_serial, { component_serial, part_number, source }, at);
  }

  // ---------- 接单与工艺冻结 ----------

  openCase({ case_id, vehicle_id, shop_id, technician_id, at }) {
    if (this.cases.has(case_id)) throw new Error(`维修案件 ${case_id} 已存在`);
    const vehicle = this.vehicles.get(vehicle_id);
    if (!vehicle) throw new Error(`车辆 ${vehicle_id} 的车型配置未登记`);
    this.#emit("CASE_OPENED", "repair_case", case_id, { case_id, vehicle_id, shop_id }, at);
    const notice = this.#applicableNotice(vehicle, at);
    const procedureVersion = notice ? `${notice.notice_id}@${notice.notice_version}` : "default@1";
    this.#emit("PROCEDURE_AUTHORIZED", "repair_case", case_id, {
      case_id,
      procedure_version: procedureVersion,
      notice_id: notice?.notice_id ?? null,
      notice_version: notice?.notice_version ?? null,
      technician_id,
      steps: clone(notice?.procedure.steps ?? []),
    }, at);
    return this.caseSnapshot(case_id);
  }

  signOffStep({ case_id, step_id, technician_ids, at }) {
    const c = this.#requireCase(case_id);
    if (c.dispute_locked) throw new Error(`案件 ${case_id} 因回执争议被锁定`);
    if (c.status === "paused" || c.reevaluation_pending) throw new Error(`案件 ${case_id} 已暂停，等待重新评估工艺`);
    if (c.status === "delivered") throw new Error(`案件 ${case_id} 已交付`);
    const step = c.procedure?.steps.find((item) => item.step_id === step_id);
    if (!step) throw new Error(`案件 ${case_id} 当前工艺中不存在步骤 ${step_id}`);
    const record = c.steps.get(step_id);
    if (record.status === "done") throw new Error(`步骤 ${step_id} 已完成，不能重复签认`);
    const distinct = [...new Set(technician_ids)];
    if (step.dangerous && distinct.length < 2) throw new Error(`危险步骤 ${step_id} 必须由两名不同技师双人签认`);
    if (!step.dangerous && distinct.length < 1) throw new Error(`步骤 ${step_id} 至少需要一名技师签认`);
    const qualification = step.requires_qualification ?? (step.dangerous ? DEFAULT_DANGEROUS_QUALIFICATION : null);
    if (qualification) for (const id of distinct) this.#assertQualified(id, qualification, at);
    this.#emit("STEP_SIGNED_OFF", "repair_case", case_id, { case_id, step_id, technician_ids: distinct, dangerous: Boolean(step.dangerous) }, at);
    return this.caseSnapshot(case_id);
  }

  reportConfigMismatch({ case_id, step_id, expected, found, at }) {
    const c = this.#requireCase(case_id);
    if (c.status === "delivered") throw new Error(`案件 ${case_id} 已交付，不能登记配置不符`);
    if (!c.steps.has(step_id)) throw new Error(`案件 ${case_id} 当前工艺中不存在步骤 ${step_id}`);
    this.#emit("CONFIG_MISMATCH_DETECTED", "repair_case", case_id, { case_id, step_id, expected, found }, at);
    return this.caseSnapshot(case_id);
  }

  reevaluateCase({ case_id, technician_id, at }) {
    const c = this.#requireCase(case_id);
    if (!c.reevaluation_pending) throw new Error(`案件 ${case_id} 无需重新评估`);
    const vehicle = this.vehicles.get(c.vehicle_id);
    const notice = this.#applicableNotice(vehicle, at);
    const procedureVersion = notice ? `${notice.notice_id}@${notice.notice_version}` : "default@1";
    this.#emit("PROCEDURE_AUTHORIZED", "repair_case", case_id, {
      case_id,
      procedure_version: procedureVersion,
      notice_id: notice?.notice_id ?? null,
      notice_version: notice?.notice_version ?? null,
      technician_id,
      steps: clone(notice?.procedure.steps ?? []),
    }, at);
    return this.caseSnapshot(case_id);
  }

  // ---------- 替换件唯一预留与安装 ----------

  reserveComponent({ case_id, component_serial, at }) {
    this.#requireCase(case_id);
    const comp = this.components.get(component_serial);
    if (!comp) throw new Error(`替换件 ${component_serial} 未登记`);
    if (comp.status !== "available") throw new Error(`替换件 ${component_serial} 已被占用，唯一替换件不能超配`);
    this.#emit("COMPONENT_RESERVED", "component_unit", component_serial, { component_serial, case_id }, at);
  }

  installComponent({ case_id, component_serial, at }) {
    const c = this.#requireCase(case_id);
    const comp = this.components.get(component_serial);
    if (!comp) throw new Error(`替换件 ${component_serial} 未登记`);
    if (comp.status !== "reserved" || comp.case_id !== case_id) {
      throw new Error(`替换件 ${component_serial} 未预留给案件 ${case_id}`);
    }
    this.#emit("COMPONENT_INSTALLED", "component_unit", component_serial, { component_serial, case_id, vehicle_id: c.vehicle_id }, at);
  }

  // ---------- 回执幂等、争议与费用冲正 ----------

  submitReceipt({ receipt_id, kind, case_id, vehicle_id, at, ...rest }) {
    if (!["diagnostic", "settlement"].includes(kind)) throw new Error(`未知回执类型 ${kind}`);
    this.#requireCase(case_id);
    if (kind === "settlement" && rest.amount === undefined) throw new Error("结算回执缺少金额");
    const content = { receipt_id, kind, case_id, vehicle_id, ...rest };
    const existing = this.receipts.get(receipt_id);
    if (existing) {
      if (isDeepStrictEqual(existing.content, content)) return { recorded: false, duplicate: true };
      this.#emit("DISPUTE_LOCKED", "repair_case", case_id, { receipt_id, case_id, reason: "同一回执序列出现不同的零件、金额或车辆" }, at);
      return { recorded: false, dispute: true };
    }
    const eventType = kind === "diagnostic" ? "DIAGNOSTIC_RECORDED" : "SETTLEMENT_RECORDED";
    this.#emit(eventType, "repair_case", case_id, content, at);
    return { recorded: true };
  }

  correctFee({ case_id, original_receipt_id, correction_id, amount_delta, reason, at }) {
    this.#requireCase(case_id);
    if (!this.receipts.has(original_receipt_id)) throw new Error(`原结算回执 ${original_receipt_id} 不存在，无法冲正`);
    this.#emit("FEE_CORRECTED", "repair_case", case_id, { case_id, correction_id, original_receipt_id, amount_delta, reason }, at);
  }

  // ---------- 公告、迟到义务与召回待办 ----------

  publishNotice({ notice_id, notice_version, affected_scope, effective_from, effective_to = null, procedure = { steps: [] }, published_at }) {
    this.#emit("NOTICE_PUBLISHED", "technical_notice", notice_id, {
      notice_id, notice_version, affected_scope, effective_from, effective_to, procedure,
    }, published_at);
    const raised = [];
    for (const vehicle of this.vehicles.values()) {
      if (!this.#inScope(vehicle, affected_scope)) continue;
      const vehicleCases = [...this.cases.values()].filter((c) => c.vehicle_id === vehicle.vehicle_id);
      const active = vehicleCases.find((c) => ["open", "in_progress", "paused"].includes(c.status));
      if (active) {
        // 仍在修：暂停并重新评估
        const obligation = this.#raiseObligation({ type: "stop_and_reevaluate", vehicle, caseId: active.case_id, noticeId: notice_id, at: published_at });
        if (obligation) raised.push(obligation);
        continue;
      }
      for (const delivered of vehicleCases.filter((c) => c.status === "delivered")) {
        const inWarranty = delivered.warranty && Date.parse(delivered.warranty.coverage_until) >= Date.parse(published_at);
        // 已交付：进入质保的生成质保召回，其余的生成客户通知
        const type = inWarranty ? "warranty_recall" : "customer_notification";
        const obligation = this.#raiseObligation({ type, vehicle, caseId: delivered.case_id, noticeId: notice_id, at: published_at });
        if (obligation) raised.push(obligation);
      }
    }
    return raised;
  }

  #raiseObligation({ type, vehicle, caseId, noticeId, at }) {
    const dedupeKey = `${noticeId}:${vehicle.vehicle_id}:${type}`;
    if ([...this.obligations.values()].some((item) => item.dedupe_key === dedupeKey)) return null;
    const obligationId = `obg-${this.sequence + 1}`;
    const aggregateType = caseId ? "repair_case" : "vehicle_configuration";
    const aggregateId = caseId ?? vehicle.vehicle_id;
    this.#emit("OBLIGATION_RAISED", aggregateType, aggregateId, {
      obligation_id: obligationId,
      obligation_type: type,
      vehicle_id: vehicle.vehicle_id,
      case_id: caseId,
      notice_id: noticeId,
      dedupe_key: dedupeKey,
    }, at);
    return this.obligations.get(obligationId);
  }

  recordDispatch({ obligation_id, channel, at }) {
    const obligation = this.obligations.get(obligation_id);
    if (!obligation) throw new Error(`义务 ${obligation_id} 不存在`);
    if (obligation.dispatched) return { dispatched: false, duplicate: true };
    const aggregateType = obligation.case_id ? "repair_case" : "vehicle_configuration";
    const aggregateId = obligation.case_id ?? obligation.vehicle_id;
    this.#emit("DISPATCH_RECORDED", aggregateType, aggregateId, { obligation_id, channel }, at);
    return { dispatched: true };
  }

  pendingObligations() {
    return [...this.obligations.values()].filter((item) => item.status === "pending").map(clone);
  }

  pendingDispatches() {
    return this.pendingObligations().filter((item) => !item.dispatched);
  }

  // ---------- 交付与质保 ----------

  deliverCase({ case_id, at }) {
    const c = this.#requireCase(case_id);
    if (c.dispute_locked) throw new Error(`案件 ${case_id} 因回执争议被锁定，不能交付`);
    if (c.status === "paused" || c.reevaluation_pending) throw new Error(`案件 ${case_id} 已暂停，等待重新评估工艺`);
    if (c.status === "delivered") throw new Error(`案件 ${case_id} 已交付，不能重复交付`);
    const undone = (c.procedure?.steps ?? []).filter((step) => c.steps.get(step.step_id)?.status !== "done");
    if (undone.length > 0) throw new Error(`存在未完成步骤: ${undone.map((step) => step.step_id).join(", ")}`);
    this.#emit("CASE_DELIVERED", "repair_case", case_id, { case_id, vehicle_id: c.vehicle_id }, at);
  }

  issueWarranty({ case_id, warranty_id, coverage_until, commitment = null, at }) {
    const c = this.#requireCase(case_id);
    if (c.status !== "delivered") throw new Error(`案件 ${case_id} 尚未交付，不能签发质保承诺`);
    this.#emit("WARRANTY_ISSUED", "repair_case", case_id, { case_id, warranty_id, coverage_until, commitment }, at);
  }

  // ---------- 查询视图 ----------

  caseSnapshot(case_id) {
    const c = this.#requireCase(case_id);
    return {
      case_id: c.case_id,
      vehicle_id: c.vehicle_id,
      shop_id: c.shop_id,
      status: c.status,
      procedure_version: c.procedure?.procedure_version ?? null,
      reevaluation_pending: c.reevaluation_pending,
      dispute_locked: c.dispute_locked,
      opened_at: c.opened_at,
      delivered_at: c.delivered_at,
      steps: (c.procedure?.steps ?? []).map((step) => ({
        step_id: step.step_id,
        name: step.name ?? null,
        dangerous: Boolean(step.dangerous),
        status: c.steps.get(step.step_id)?.status ?? "pending",
        facts: clone(c.steps.get(step.step_id)?.facts ?? []),
      })),
      warranty: clone(c.warranty),
    };
  }

  nextAuthorization(case_id) {
    const c = this.#requireCase(case_id);
    if (c.dispute_locked) return { case_id, blocked: true, reasons: ["回执争议锁定，需先解除争议"] };
    if (c.status === "paused" || c.reevaluation_pending) return { case_id, blocked: true, reasons: ["案件暂停，等待重新评估工艺"] };
    if (c.status === "delivered") return { case_id, blocked: false, next: null, reasons: [] };
    const step = (c.procedure?.steps ?? []).find((item) => c.steps.get(item.step_id)?.status !== "done");
    if (!step) return { case_id, blocked: false, next: "deliver", reasons: [] };
    return {
      case_id,
      blocked: false,
      next: step.step_id,
      requirements: {
        dangerous: Boolean(step.dangerous),
        signoffs_required: step.dangerous ? 2 : 1,
        qualification: step.requires_qualification ?? (step.dangerous ? DEFAULT_DANGEROUS_QUALIFICATION : null),
      },
    };
  }

  /** 车主维修证明：只含事实与承诺，不含工艺步骤细节等商业工艺。 */
  ownerCertificate(case_id) {
    const c = this.#requireCase(case_id);
    const vehicle = this.vehicles.get(c.vehicle_id);
    const parts = [...this.components.values()]
      .filter((comp) => comp.vehicle_id === c.vehicle_id && comp.status === "installed")
      .map((comp) => ({ component_serial: comp.component_serial, part_number: comp.part_number, source: comp.source }));
    return {
      case_id: c.case_id,
      vehicle_id: c.vehicle_id,
      shop_id: c.shop_id,
      opened_at: c.opened_at,
      delivered_at: c.delivered_at,
      software_version: vehicle?.software_version ?? null,
      authorized_procedure_version: c.procedure?.procedure_version ?? null,
      parts,
      warranty: c.warranty ? clone(c.warranty) : null,
    };
  }

  /** 审计追溯：从故障结论追到证据、人员、部件与费用冲正。 */
  auditTrace(case_id) {
    const c = this.#requireCase(case_id);
    const signoffs = {};
    const facts = [];
    for (const [stepId, record] of c.steps) {
      if (record.signoffs.length > 0) signoffs[stepId] = [...record.signoffs];
      for (const fact of record.facts) facts.push({ type: "config_mismatch", step_id: stepId, ...clone(fact) });
    }
    const basisOf = (procedure) => ({
      notice_id: procedure.notice_id,
      notice_version: procedure.notice_version,
      procedure_version: procedure.procedure_version,
      authorized_by: procedure.authorized_by,
    });
    return {
      case_id: c.case_id,
      conclusion: c.diagnostics.at(-1)?.content.conclusion ?? null,
      evidence: [
        ...c.diagnostics.map((entry) => ({ type: "diagnostic", receipt_id: entry.content.receipt_id, conclusion: entry.content.conclusion ?? null, recorded_at: entry.recorded_at })),
        ...facts,
      ],
      personnel: {
        authorizers: [...c.procedure_history.map((item) => item.authorized_by), c.procedure?.authorized_by].filter(Boolean),
        signoffs,
      },
      parts: {
        reserved: [...this.components.values()].filter((comp) => comp.case_id === case_id && comp.status === "reserved").map((comp) => comp.component_serial),
        installed: [...this.components.values()].filter((comp) => comp.case_id === case_id && comp.status === "installed").map((comp) => comp.component_serial),
      },
      fees: {
        settlements: c.settlements.map((entry) => ({ receipt_id: entry.content.receipt_id, amount: entry.content.amount ?? null, recorded_at: entry.recorded_at })),
        corrections: c.corrections.map((item) => ({ correction_id: item.correction_id, original_receipt_id: item.original_receipt_id, amount_delta: item.amount_delta, reason: item.reason ?? null })),
      },
      dispute_locked: c.dispute_locked,
      legal_basis: [...c.procedure_history.map(basisOf), ...(c.procedure ? [basisOf(c.procedure)] : [])],
    };
  }
}
