from __future__ import annotations

import json
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import ManagementAction, utcnow


def sync_actions(session: Session, campaign_id: str, specs: list[dict]) -> list[ManagementAction]:
    now = utcnow()
    seen = {item["action_id"] for item in specs}
    existing = {
        item.action_id: item
        for item in session.scalars(
            select(ManagementAction).where(ManagementAction.campaign_id == campaign_id)
        ).all()
    }
    for spec in specs:
        item = existing.get(spec["action_id"])
        if item is None:
            item = ManagementAction(
                action_id=spec["action_id"],
                campaign_id=campaign_id,
                kind=spec["kind"],
                severity=spec["severity"],
                title=spec["title"],
                summary=spec["summary"],
                evidence_json=json.dumps(spec["evidence"], ensure_ascii=False, sort_keys=True),
                deep_link=spec.get("deep_link"),
            )
            session.add(item)
            existing[item.action_id] = item
        else:
            item.kind = spec["kind"]
            item.severity = spec["severity"]
            item.title = spec["title"]
            item.summary = spec["summary"]
            item.evidence_json = json.dumps(spec["evidence"], ensure_ascii=False, sort_keys=True)
            item.deep_link = spec.get("deep_link")
            item.last_seen_at = now
            if item.status == "resolved":
                item.status = "active"
                item.resolved_at = None
            if item.status == "snoozed" and item.snoozed_until and item.snoozed_until <= now:
                item.status = "active"
                item.snoozed_until = None
    for action_id, item in existing.items():
        if action_id not in seen and item.status in {"active", "accepted", "snoozed"}:
            item.status = "resolved"
            item.resolved_at = now
    session.flush()
    return list(existing.values())


def action_dict(item: ManagementAction) -> dict:
    return {
        "action_id": item.action_id,
        "campaign_id": item.campaign_id,
        "kind": item.kind,
        "severity": item.severity,
        "title": item.title,
        "summary": item.summary,
        "evidence": json.loads(item.evidence_json),
        "deep_link": item.deep_link,
        "status": item.status,
        "snoozed_until": item.snoozed_until.isoformat() if item.snoozed_until else None,
        "first_seen_at": item.first_seen_at.isoformat(),
        "last_seen_at": item.last_seen_at.isoformat(),
        "resolved_at": item.resolved_at.isoformat() if item.resolved_at else None,
    }
