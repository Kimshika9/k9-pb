"""Owner-private Telegram menus; all persistent business work goes to the Worker."""

from __future__ import annotations
import copy
import html
import logging
import secrets
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from telegram import InlineKeyboardButton as Button, InlineKeyboardMarkup, WebAppInfo
from telegram.ext import CommandHandler, CallbackQueryHandler, MessageHandler, filters
from telegram.error import TelegramError
from .bridge import Bridge, BridgeError
from .config import Config


def esc(value) -> str:
    return html.escape(str(value))


@dataclass
class Session:
    nonce: str = field(default_factory=lambda: secrets.token_hex(6))
    created: float = field(default_factory=time.monotonic)
    actions: dict = field(default_factory=dict)
    message_id: int | None = None
    flow: dict | None = None


class StudioBot:
    def __init__(self, config: Config, bridge: Bridge):
        self.config, self.bridge = config, bridge
        self.session = Session()
        self.stack = []

    def owner(self, update) -> bool:
        user, chat = update.effective_user, update.effective_chat
        return bool(
            user
            and chat
            and user.id == self.config.owner_id
            and chat.id == self.config.owner_id
            and chat.type == "private"
        )

    def button(self, text: str, action: str, **data) -> Button:
        key = str(len(self.session.actions))
        self.session.actions[key] = (action, data)
        return Button(text, callback_data=f"k9b:{self.session.nonce}:{key}")

    def web_button(self, label="OPEN WEB STUDIO") -> Button:
        return Button(label, web_app=WebAppInfo(self.config.web_app_url))

    async def show(self, update, text: str, rows: list, *, flow=None):
        rows.append(
            [
                self.button("‹ Back", "back"),
                self.button("⌂ Home", "home"),
                self.button("Cancel", "cancel"),
            ]
        )
        self.session.flow = flow
        markup = InlineKeyboardMarkup(rows)
        if update.callback_query and update.callback_query.message:
            message = await update.callback_query.edit_message_text(
                text, parse_mode="HTML", reply_markup=markup
            )
        else:
            message = await update.effective_message.reply_text(
                text, parse_mode="HTML", reply_markup=markup
            )
        self.session.message_id = message.message_id

    def fresh(self):
        self.session = Session()

    async def command(self, update, context):
        if not self.owner(update):
            return
        self.fresh()
        self.stack = []
        name = update.effective_message.text.split()[0].split("@")[0].lstrip("/")
        route = {
            "start": "home",
            "studio": "studio",
            "help": "help",
            "status": "status",
            "channels": "channels",
            "posts": "posts",
            "drafts": "drafts",
            "published": "published",
            "scheduled": "scheduled",
            "templates": "templates",
            "media": "media",
            "preview": "drafts",
            "publish": "drafts",
            "schedule": "drafts",
            "cancel": "scheduled",
            "settings": "settings",
        }.get(name, "home")
        await self.safe_dispatch(update, route, {})

    async def callback(self, update, context):
        query = update.callback_query
        if not self.owner(update):
            await query.answer("Private owner workspace.", show_alert=True)
            return
        if query.data == "k9:preview":
            await query.answer("Test preview only. No action executed.")
            return
        parts = (query.data or "").split(":")
        if (
            len(parts) != 3
            or parts[0] != "k9b"
            or parts[1] != self.session.nonce
            or time.monotonic() - self.session.created > 600
            or not query.message
            or query.message.message_id != self.session.message_id
            or parts[2] not in self.session.actions
        ):
            await query.answer(
                "This menu expired. Use /start for current data.", show_alert=True
            )
            return
        await query.answer()
        action, data = self.session.actions.pop(parts[2])
        self.fresh()  # All callbacks from the old screen become stale immediately.
        await self.safe_dispatch(update, action, data)

    async def safe_dispatch(self, update, action: str, data: dict):
        try:
            if action == "back":
                if self.stack:
                    self.stack.pop()
                action, data = self.stack[-1] if self.stack else ("home", {})
            if action in (
                "home",
                "posts",
                "drafts",
                "channels",
                "published",
                "scheduled",
                "media",
                "templates",
                "draft",
                "publication",
                "job",
                "settings",
                "help",
                "studio",
                "choose_channel",
                "destination",
            ):
                if not self.stack or self.stack[-1] != (action, data):
                    self.stack.append((action, data.copy()))
                    self.stack = self.stack[-32:]
            await self.dispatch(update, action, data)
        except BridgeError as error:
            self.fresh()
            rows = [[self.button("Refresh status", "status")]]
            operation = data.get("operationId")
            message = f"<b>K9 :: backend notice</b>\n\n<code>{esc(error.code)}</code>\n{esc(error)}"
            if operation:
                message += f"\n\nOperation: <code>{operation}</code>\nInspect its status before trying a new send."
                rows.insert(
                    0,
                    [
                        self.button(
                            "Inspect operation", "operation", operationId=operation
                        )
                    ],
                )
                if error.code in ("TELEGRAM_RATE_LIMIT", "TELEGRAM_TEMPORARY"):
                    rows.insert(
                        1, [self.button("Retry original operation", action, **data)]
                    )
            await self.show(update, message, rows)

    async def dispatch(self, update, action: str, data: dict):
        if action in ("home", "cancel"):
            await self.show(
                update,
                "<b>⌘ K9 POST STUDIO</b>\n<code>owner.workspace / online</code>\n\nYour private publishing control panel.\nChoose a workspace below.",
                [
                    [self.web_button()],
                    [
                        self.button("＋ CREATE POST", "create"),
                        self.button("POST MANAGER", "posts"),
                    ],
                    [
                        self.button("CHANNELS", "channels"),
                        self.button("SCHEDULED POSTS", "scheduled"),
                    ],
                    [
                        self.button("MEDIA LIBRARY", "media"),
                        self.button("SYSTEM STATUS", "status"),
                    ],
                    [self.button("SETTINGS", "settings"), self.button("HELP", "help")],
                ],
            )
        elif action == "studio":
            await self.show(
                update,
                "<b>K9 :: Web Studio</b>\n\nOpen the owner-only Mini App for the full rich editor. Telegram supplies fresh signed initialization data; the Worker verifies it.",
                [[self.web_button()]],
            )
        elif action == "help":
            await self.show(
                update,
                "<b>K9 :: command reference</b>\n\n/start · /help · /studio · /status\n/channels · /posts · /drafts · /published\n/scheduled · /templates · /media\n/preview · /publish · /schedule · /cancel\n/settings\n\nUse selection menus; no IDs to memorize. Create simple text drafts here, design advanced blocks in Web Studio. Sends require explicit confirmation.",
                [[self.web_button()]],
            )
        elif action == "posts":
            await self.show(
                update,
                "<b>K9 :: Post Manager</b>\n\nShared with your Web Studio. Refresh to see its latest saved state.",
                [
                    [
                        self.button("Draft posts", "drafts"),
                        self.button("Published", "published"),
                    ],
                    [
                        self.button("Templates", "templates"),
                        self.button("Create post", "create"),
                    ],
                    [self.button("Refresh", "posts")],
                ],
            )
        elif action == "status":
            value = await self.bridge.request("GET", "/doctor")
            counts = value["counts"]
            await self.show(
                update,
                f"<b>K9 :: System Status</b>\n<code>Worker / D1 / bridge</code>\n\nPublished: {counts['published']}\nScheduled: {counts['scheduled']}\nUncertain: {counts['uncertain']}\nCron: {'enabled' if value['schedulerEnabled'] else 'disabled'}\nStorage schema: {value['schema']}\n\nBot reception and Cloudflare scheduling are separate services.",
                [[self.button("Refresh", "status")]],
            )
        elif action == "settings":
            value = await self.bridge.request("GET", "/runtime")
            await self.show(
                update,
                f"<b>K9 :: Owner Settings</b>\n\nReceiver: {esc(value['runtime']['mode'])}\nLocal mode: {esc(self.config.runtime_mode)}\n\nStart the bot with <code>python bot.py</code>; setup and receiver checks run automatically. To restore Cloudflare, stop Python and optionally run <code>python bot.py --restore-cloudflare</code>. Any active-webhook change requires explicit confirmation.\n\nNo credentials are displayed here.",
                [[self.web_button()], [self.button("Refresh", "settings")]],
            )
        elif action in (
            "drafts",
            "channels",
            "published",
            "scheduled",
            "media",
            "templates",
        ):
            await self.list_items(update, action, data.get("offset", 0))
        elif action == "draft":
            draft = (await self.bridge.request("GET", "/drafts/" + data["id"]))["draft"]
            await self.show(
                update,
                f"<b>K9 :: Draft</b>\n\n{esc(draft['title'])}\nSaved revision: {draft['revision']}\n\nPreview is private. Publishing uses approved channels and the same rich renderer as Web Studio.",
                [
                    [
                        self.button(
                            "Send Test Preview",
                            "preview",
                            id=draft["id"],
                            revision=draft["revision"],
                            operationId=str(uuid.uuid4()),
                        )
                    ],
                    [
                        self.button(
                            "Publish",
                            "choose_channel",
                            id=draft["id"],
                            revision=draft["revision"],
                            intent="publish",
                        ),
                        self.button(
                            "Schedule",
                            "choose_channel",
                            id=draft["id"],
                            revision=draft["revision"],
                            intent="schedule",
                        ),
                    ],
                    [self.web_button("Edit in Web Studio")],
                    [self.button("Refresh draft", "draft", id=draft["id"])],
                ],
            )
        elif action == "choose_channel":
            channels = (await self.bridge.request("GET", "/channels"))["channels"]
            approved = [c for c in channels if c["active"] == 1 and c["approved_at"]]
            offset = data.get("channelOffset", 0)
            rows = [
                [self.button(c["title"][:45], "destination", **data, channelId=c["id"])]
                for c in approved[offset : offset + 12]
            ]
            if len(approved) > offset + 12:
                rows.append(
                    [
                        self.button(
                            "More channels ›",
                            "choose_channel",
                            **{**data, "channelOffset": offset + 12},
                        )
                    ]
                )
            if offset:
                rows.append(
                    [
                        self.button(
                            "‹ Previous channels",
                            "choose_channel",
                            **{**data, "channelOffset": max(0, offset - 12)},
                        )
                    ]
                )
            await self.show(
                update,
                (
                    "<b>K9 :: Destination</b>\n\nSelect an approved channel."
                    if rows
                    else "<b>K9 :: No approved channel</b>\nConnect and explicitly approve a channel in Web Studio."
                ),
                rows + [[self.web_button()]],
            )
        elif action == "destination":
            ready = await self.bridge.request(
                "POST",
                f"/posts/{data['id']}/check",
                {"revision": data["revision"], "channelId": data["channelId"]},
            )
            if data["intent"] == "schedule":
                await self.show(
                    update,
                    f"<b>K9 :: Schedule</b>\n{esc(ready['title'])}\n→ {esc(ready['channelTitle'])}\n\nSend a future date/time:\n<code>YYYY-MM-DD HH:MM Asia/Yangon</code>\nor <code>YYYY-MM-DD HH:MM UTC</code>.\nExample: <code>2026-11-01 12:00 Asia/Yangon</code>\nThe backend stores UTC and the saved revision.",
                    [],
                    flow={
                        "kind": "schedule",
                        **data,
                        "title": ready["title"],
                        "channelTitle": ready["channelTitle"],
                    },
                )
            else:
                await self.show(
                    update,
                    f"<b>K9 :: Confirm publication</b>\n\n{esc(ready['title'])}\n→ {esc(ready['channelTitle'])}\nRevision {data['revision']}\n\nRich content, registered media and current permissions checked. The backend checks again before sending. This sends a real channel message.",
                    [
                        [
                            self.button(
                                "CONFIRM PUBLISH",
                                "publish",
                                **data,
                                operationId=str(uuid.uuid4()),
                            )
                        ]
                    ],
                )
        elif action in ("preview", "publish", "send_schedule"):
            await self.delivery(update, action, data)
        elif action == "operation":
            value = (
                await self.bridge.request("GET", "/operations/" + data["operationId"])
            )["operation"]
            await self.show(
                update,
                f"<b>K9 :: Operation</b>\n<code>{esc(value['id'])}</code>\nStatus: {esc(value['status'])}\n{esc(value.get('last_error_code') or '')}\n\nUncertain results require Telegram inspection and reconciliation in Web Studio. No resend was performed.",
                [
                    [self.button("Refresh operation", "operation", **data)],
                    [self.web_button()],
                ],
            )
        elif action == "publication":
            value = await self.bridge.request("GET", "/publications/" + data["id"])
            p = value["publication"]
            history = (
                "\n".join(esc(h["action"]) for h in value["history"][:8])
                or "No history yet."
            )
            await self.show(
                update,
                f"<b>K9 :: Publication</b>\n\n{esc(p['title'])}\nStatus: {esc(p['status'])}\nMessage: {esc(p['telegram_message_id'] or 'unconfirmed')}\n{esc(p.get('last_error_code') or '')}\n\n<b>Recent history</b>\n{history}\n\nEdit/delete/republish and reconciliation are available in Web Studio.",
                [[self.web_button()], [self.button("Refresh", "publication", **data)]],
            )
        elif action == "job":
            job = (await self.bridge.request("GET", "/scheduled/" + data["id"]))["job"]
            if not job:
                raise BridgeError(
                    404, "NOT_FOUND", "Job is unavailable. Refresh the scheduled list."
                )
            rows = [[self.button("Refresh", "job", **data)]]
            if (
                job["status"] in ("pending", "failed")
                and job["delivery_state"] != "uncertain"
            ):
                rows.insert(
                    0, [self.button("Cancel this schedule", "confirm_cancel", **job)]
                )
            await self.show(
                update,
                f"<b>K9 :: Scheduled Job</b>\n{esc(job['title'] or 'Legacy job')}\nUTC: {esc(job['run_at'])}\nStatus: {esc(job['status'])} / {esc(job['delivery_state'])}\nAttempts: {job['attempts']}\n{esc(job.get('last_error_code') or '')}",
                rows,
            )
        elif action == "confirm_cancel":
            await self.show(
                update,
                "<b>K9 :: Confirm cancellation</b>\n\nCancel this saved job? Source draft and history remain intact.",
                [
                    [
                        self.button(
                            "CONFIRM CANCEL",
                            "cancel_job",
                            id=data["id"],
                            revision=data["revision"],
                            operationId=str(uuid.uuid4()),
                        )
                    ]
                ],
            )
        elif action == "cancel_job":
            result = await self.bridge.request(
                "POST",
                "/scheduled/" + data["id"] + "/cancel",
                {"operationId": data["operationId"], "revision": data["revision"]},
            )
            await self.show(
                update,
                f"<b>K9 :: Schedule {esc(result['job']['status'])}</b>\nSource draft preserved.",
                [[self.button("Scheduled posts", "scheduled")]],
            )
        elif action == "create":
            await self.show(
                update,
                "<b>K9 :: Create Post</b>\n\nSend a title (1–160 characters). Next I’ll ask for paragraph text. Use Web Studio for advanced layout.",
                [],
                flow={"kind": "title"},
            )
        elif action == "template":
            templates = (await self.bridge.request("GET", "/templates"))["templates"]
            t = next((t for t in templates if t["id"] == data["id"]), None)
            if not t:
                raise BridgeError(
                    404, "NOT_FOUND", "Template is unavailable. Refresh templates."
                )
            document = copy.deepcopy(t["document"])

            def renew(value):
                if isinstance(value, dict):
                    for key, child in value.items():
                        if key == "id":
                            value[key] = str(uuid.uuid4())
                        else:
                            renew(child)
                elif isinstance(value, list):
                    for child in value:
                        renew(child)

            renew(document)
            result = await self.bridge.request(
                "POST", "/drafts", {"title": t["name"], "document": document}
            )
            await self.dispatch(update, "draft", {"id": result["draft"]["id"]})
        else:
            raise BridgeError(400, "STALE_ACTION", "Unknown menu action. Open /start.")

    async def list_items(self, update, kind: str, offset: int):
        paths = {
            "drafts": "/drafts",
            "channels": "/channels",
            "published": "/publications",
            "scheduled": "/scheduled",
            "templates": "/templates",
            "media": "/media",
        }
        keys = {"published": "publications", "scheduled": "jobs"}
        value = await self.bridge.request(
            "GET",
            paths[kind]
            + (f"?offset={offset}" if kind not in ("channels", "templates") else ""),
        )
        items = value[keys.get(kind, kind)]
        # Keep Telegram keyboards bounded; paginate within the API page if necessary.
        page_items = items[:12]
        rows, lines = [], []
        for item in page_items:
            title = (
                item.get("title")
                or item.get("name")
                or item.get("original_name")
                or "Untitled"
            )
            if kind == "channels":
                lines.append(
                    f"{'🟢' if item['active'] and item['approved_at'] else '⚪'} {esc(title[:80])}"
                )
            elif kind == "media":
                lines.append(
                    f"{esc(item['kind'])} · {esc(title[:80])} · {item['size_bytes']} bytes"
                )
            else:
                action = {
                    "drafts": "draft",
                    "published": "publication",
                    "scheduled": "job",
                    "templates": "template",
                }[kind]
                rows.append([self.button(title[:45], action, id=item["id"])])
        # Worker page sizes are larger; offsets advance by displayed records so none are skipped.
        next_offset = offset + 12 if len(items) > 12 else value.get("nextOffset")
        if kind in ("channels", "templates"):
            selected = items[offset : offset + 12]
            if offset:
                if kind == "channels":
                    lines = [
                        f"{'🟢' if i['active'] and i['approved_at'] else '⚪'} {esc(i['title'][:80])}"
                        for i in selected
                    ]
                else:
                    rows = [
                        [self.button(i["name"][:45], "template", id=i["id"])]
                        for i in selected
                    ]
            next_offset = offset + 12 if len(items) > offset + 12 else None
        if next_offset is not None:
            rows.append([self.button("Next page ›", kind, offset=next_offset)])
        if offset:
            rows.append(
                [self.button("‹ Previous page", kind, offset=max(0, offset - 12))]
            )
        rows.append([self.button("Refresh", kind, offset=offset), self.web_button()])
        description = (
            "\n".join(lines)
            if lines
            else "Select an item below." if items else "Your library is empty."
        )
        if kind == "media":
            description += "\n\nSend a photo, video or document in this private chat to register it. Files appear in the Web Studio picker."
        if kind == "channels":
            description += "\n\nApprove/revoke channels in Web Studio; arbitrary chats cannot receive posts."
        await self.show(
            update, f"<b>K9 :: {esc(kind.title())}</b>\n\n{description}", rows
        )

    async def delivery(self, update, action: str, data: dict):
        kind = "schedule" if action == "send_schedule" else action
        payload = {"operationId": data["operationId"], "revision": data["revision"]}
        if kind != "preview":
            payload["channelId"] = data["channelId"]
        if kind == "schedule":
            payload.update(runAt=data["runAt"], timezone=data["timezone"])
        result = await self.bridge.request(
            "POST", f"/posts/{data['id']}/{kind}", payload
        )
        if kind == "schedule":
            message = "Schedule stored in UTC. Check Scheduled for queue state; delivery requires enabled Cloudflare Cron."
        else:
            p = result.get("publication", {})
            if p.get("status") != "published" or not p.get("telegram_message_id"):
                raise BridgeError(
                    0,
                    "API_UNCONFIRMED",
                    "No confirmed published receipt. Inspect this operation.",
                )
            message = f"{'Private test preview' if kind == 'preview' else 'Channel publication'} confirmed by Telegram.\nMessage: {p['telegram_message_id']}"
        await self.show(
            update,
            "<b>K9 :: Delivery result</b>\n\n"
            + message
            + f"\nOperation: <code>{data['operationId']}</code>",
            [
                [
                    self.button(
                        "Inspect operation",
                        "operation",
                        operationId=data["operationId"],
                    )
                ],
                [self.button("Post Manager", "posts")],
            ],
        )

    async def text(self, update, context):
        if not self.owner(update):
            return
        flow = self.session.flow
        if not flow or time.monotonic() - self.session.created > 600:
            self.fresh()
            await self.show(
                update,
                "<b>K9 :: Ready</b>\nUse /start to open your studio, or send supported media.",
                [[self.web_button()]],
            )
            return
        value = update.effective_message.text.strip()
        self.fresh()
        try:
            if flow["kind"] == "title":
                if not 1 <= len(value) <= 160:
                    raise ValueError("Use a title between 1 and 160 characters.")
                await self.show(
                    update,
                    "<b>K9 :: Post text</b>\nSend your paragraph text (up to 4000 characters). Unicode is supported. Formatting and advanced blocks can be added in Web Studio.",
                    [],
                    flow={"kind": "body", "title": value},
                )
            elif flow["kind"] == "body":
                if not 1 <= len(value.encode("utf-16-le")) // 2 <= 4000:
                    raise ValueError("Use 1–4000 text characters.")
                result = await self.bridge.request(
                    "POST",
                    "/drafts",
                    {
                        "title": flow["title"],
                        "document": {
                            "version": 2,
                            "blocks": [
                                {
                                    "id": str(uuid.uuid4()),
                                    "type": "paragraph",
                                    "text": [{"text": value, "marks": []}],
                                }
                            ],
                        },
                    },
                )
                await self.dispatch(update, "draft", {"id": result["draft"]["id"]})
            elif flow["kind"] == "schedule":
                pieces = value.rsplit(" ", 1)
                if len(pieces) != 2 or pieces[1] not in ("UTC", "Asia/Yangon"):
                    raise ValueError("Use YYYY-MM-DD HH:MM UTC or Asia/Yangon.")
                zone = pieces[1]
                local = datetime.strptime(pieces[0], "%Y-%m-%d %H:%M")
                utc = local.replace(
                    tzinfo=timezone(
                        timedelta(minutes=390) if zone == "Asia/Yangon" else timedelta()
                    )
                ).astimezone(timezone.utc)
                if utc <= datetime.now(timezone.utc):
                    raise ValueError("Choose a future time.")
                data = {k: v for k, v in flow.items() if k != "kind"}
                data.update(
                    runAt=utc.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                    timezone=zone,
                    operationId=str(uuid.uuid4()),
                )
                await self.show(
                    update,
                    f"<b>K9 :: Confirm schedule</b>\n{esc(flow['title'])}\n→ {esc(flow['channelTitle'])}\n{esc(value)}\nUTC: {esc(data['runAt'])}\n\nThis captures the selected saved revision.",
                    [[self.button("CONFIRM SCHEDULE", "send_schedule", **data)]],
                )
        except ValueError as error:
            await self.show(
                update,
                esc(error) + "\nPlease send a corrected value or cancel.",
                [],
                flow=flow,
            )
        except BridgeError as error:
            await self.show(
                update,
                f"<b>K9 :: Backend notice</b>\n{esc(error)}\nRefresh before another write.",
                [[self.button("Post Manager", "posts")]],
            )

    async def media(self, update, context):
        if not self.owner(update):
            return
        message = update.effective_message
        kind = "photo" if message.photo else "video" if message.video else "document"
        media = message.photo[-1] if kind == "photo" else getattr(message, kind)
        limit = (10 if kind == "photo" else 20) * 1024 * 1024
        if media.file_size is not None and media.file_size > limit:
            await message.reply_text(
                f"Studio supports {kind} registration up to {limit//1024//1024} MB. Large uploads are not verified."
            )
            return
        payload = {
            "fileId": media.file_id,
            "uniqueId": media.file_unique_id,
            "kind": kind,
            "name": (getattr(media, "file_name", None) or f"Telegram {kind}")[:200],
        }
        for key, attr in (
            ("mime", "mime_type"),
            ("width", "width"),
            ("height", "height"),
            ("duration", "duration"),
        ):
            value = getattr(media, attr, None)
            if isinstance(value, timedelta):
                value = int(value.total_seconds())
            if value is not None:
                payload[key] = value
        try:
            await self.bridge.request("POST", "/media/register", payload)
            await message.reply_text(
                "K9 :: media registered in your shared library. Refresh the Web Studio picker or use /media."
            )
        except BridgeError as error:
            await message.reply_text("K9 :: " + str(error))

    async def unsupported(self, update, context):
        if self.owner(update):
            await update.effective_message.reply_text(
                "K9 :: send a photo, video or document for the shared media library. This attachment type is unsupported."
            )

    async def error(self, update, context):
        logging.getLogger("k9").warning(
            "Telegram interaction could not be completed; credentials and update data omitted."
        )
        if update and self.owner(update) and update.effective_message:
            try:
                await update.effective_message.reply_text(
                    "K9 :: Telegram interaction failed. Use /start to refresh; inspect publication status before resending."
                )
            except TelegramError:
                pass

    def register(self, application):
        application.add_handler(
            CommandHandler(
                [
                    "start",
                    "help",
                    "studio",
                    "status",
                    "channels",
                    "posts",
                    "drafts",
                    "published",
                    "scheduled",
                    "templates",
                    "media",
                    "preview",
                    "publish",
                    "schedule",
                    "cancel",
                    "settings",
                ],
                self.command,
            )
        )
        application.add_handler(CallbackQueryHandler(self.callback))
        application.add_handler(
            MessageHandler(
                filters.PHOTO | filters.VIDEO | filters.Document.ALL, self.media
            )
        )
        application.add_handler(
            MessageHandler(filters.TEXT & ~filters.COMMAND, self.text)
        )
        application.add_handler(
            MessageHandler(
                filters.ATTACHMENT
                & ~(filters.PHOTO | filters.VIDEO | filters.Document.ALL),
                self.unsupported,
            )
        )
        application.add_error_handler(self.error)
        application.bot_data["studio"] = self
