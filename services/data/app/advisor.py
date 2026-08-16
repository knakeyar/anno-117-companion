from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import Settings
from .models import AdvisorConversation, AdvisorMessage, ManagementAction, utcnow


class AdvisorStructured(BaseModel):
    answer: str = Field(min_length=1, max_length=4000)
    referenced_action_ids: list[str] = Field(default_factory=list, max_length=12)
    cautions: list[str] = Field(default_factory=list, max_length=8)


def conversation_dict(session: Session, conversation: AdvisorConversation) -> dict:
    messages = session.scalars(
        select(AdvisorMessage)
        .where(AdvisorMessage.conversation_id == conversation.conversation_id)
        .order_by(AdvisorMessage.message_id)
    ).all()
    return {
        "conversation_id": conversation.conversation_id,
        "campaign_id": conversation.campaign_id,
        "title": conversation.title,
        "created_at": conversation.created_at.isoformat(),
        "updated_at": conversation.updated_at.isoformat(),
        "messages": [
            {
                "message_id": item.message_id,
                "role": item.role,
                "content": item.content,
                "action_ids": json.loads(item.action_ids_json or "[]"),
                "created_at": item.created_at.isoformat(),
            }
            for item in messages
        ],
    }


def ask_advisor(
    session: Session,
    settings: Settings,
    *,
    campaign_id: str,
    question: str,
    compact_context: dict,
    conversation_id: str | None = None,
    client: Any = None,
) -> dict:
    conversation = session.get(AdvisorConversation, conversation_id) if conversation_id else None
    if conversation is not None and conversation.campaign_id != campaign_id:
        raise ValueError("conversation belongs to another campaign")
    if conversation is None:
        conversation = AdvisorConversation(
            conversation_id=str(uuid.uuid4()),
            campaign_id=campaign_id,
            title=question.strip()[:80],
        )
        session.add(conversation)
        session.flush()
    session.add(AdvisorMessage(conversation_id=conversation.conversation_id, role="user", content=question.strip()))
    conversation.updated_at = utcnow()
    session.flush()

    history = session.scalars(
        select(AdvisorMessage)
        .where(AdvisorMessage.conversation_id == conversation.conversation_id)
        .order_by(AdvisorMessage.message_id.desc())
        .limit(12)
    ).all()
    history.reverse()
    if not settings.openai_api_key and client is None:
        session.commit()
        return {**conversation_dict(session, conversation), "available": False, "error": "OpenAI advisor is not configured. Deterministic actions remain available."}

    try:
        if client is None:
            from openai import OpenAI
            client = OpenAI(api_key=settings.openai_api_key, timeout=settings.openai_timeout_seconds)
        known_action_ids = set(
            session.scalars(
                select(ManagementAction.action_id).where(ManagementAction.campaign_id == campaign_id)
            ).all()
        )
        system = (
            "You are an Anno 117 economic advisor. Use only the supplied companion facts and deterministic actions. "
            "Do not imply route feasibility, measured factory rates, or game-state mutation. Give one immediate, practical priority first."
        )
        prompt = {
            "campaign_safety_id": hashlib.sha256(campaign_id.encode()).hexdigest()[:24],
            "selected_campaign_context": compact_context,
            "conversation": [{"role": item.role, "content": item.content} for item in history],
        }
        response = client.responses.parse(
            model=settings.openai_model,
            reasoning={"effort": settings.openai_reasoning_effort},
            store=False,
            safety_identifier=f"anno_{hashlib.sha256(campaign_id.encode()).hexdigest()[:24]}",
            input=[
                {"role": "system", "content": system},
                {"role": "user", "content": json.dumps(prompt, ensure_ascii=False, separators=(",", ":"))},
            ],
            text_format=AdvisorStructured,
        )
        parsed = response.output_parsed
        if parsed is None:
            raise RuntimeError("advisor returned no structured output")
        valid_ids = [item for item in parsed.referenced_action_ids if item in known_action_ids]
        content = parsed.answer
        if parsed.cautions:
            content += "\n\n" + "\n".join(f"Caution: {item}" for item in parsed.cautions)
        session.add(
            AdvisorMessage(
                conversation_id=conversation.conversation_id,
                role="assistant",
                content=content,
                action_ids_json=json.dumps(valid_ids),
            )
        )
        conversation.updated_at = utcnow()
        session.commit()
        return {**conversation_dict(session, conversation), "available": True, "error": None}
    except Exception as exc:  # the dashboard must remain useful if AI is unavailable
        session.commit()
        return {**conversation_dict(session, conversation), "available": False, "error": f"Advisor request failed: {exc}"}
