/**
 * QQ 网关的侧边栏底部按钮：一行看三个号，点右边三角展开，每个号单独看得见。
 *
 * 挂法跟 dsh-longing-entry 一样：slots.inject('sidebar.footer.action', ...)。
 * 数据走 host 那边挂的 /dsh-qq-gateway/api/*，网页半边调不到 ctx.tools。
 *
 * 原版是 dsh-qq-hub（鱼鱼写的，2026-11-15 清旧桥时被我误删，源码没留），
 * 这里按它截图里的样子重写：绿点 + 名字 + n/n + 右边小三角，展开后每个号一行。
 */
window.__ModuleLoader__.load({
  id: "@local/dsh-qq-gateway",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");
    const h = React.createElement;

    const NS = "qq-gateway-entry";
    const STATUS_URL = "/dsh-qq-gateway/api/status";
    const START_URL = "/dsh-qq-gateway/api/start";
    const FISHTALK_URL = "/dsh-qq-gateway/api/fishtalk";
    const SESSIONS_URL = "/dsh-qq-gateway/api/sessions";
    const SAVE_URL = "/dsh-qq-gateway/api/save";
    const SETTINGS_NS = "qq-gateway";
    const POLL_MS = 15000;

    const FONT = '12px';
    const BORDER = '1px solid var(--dsw-alias-border-l1, rgba(120,120,140,0.25))';

    function Dot(color, size) {
      return h("span", {
        style: {
          width: (size || 8) + "px", height: (size || 8) + "px", borderRadius: "50%",
          background: color, display: "inline-block", flex: "0 0 auto",
        },
      });
    }

    function QqGatewayEntry(props) {
      const wide = props && props.wide !== false;
      const [accounts, setAccounts] = React.useState([]);
      const [open, setOpen] = React.useState(false);
      const [note, setNote] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [hover, setHover] = React.useState(false);

      const load = React.useCallback(async () => {
        try {
          const r = await fetch(STATUS_URL, { cache: "no-store" });
          const j = await r.json();
          if (j && j.ok) { setAccounts(Array.isArray(j.accounts) ? j.accounts : []); setNote(""); }
          else setNote((j && j.error) || "读不到状态");
        } catch (e) {
          setNote("读不到状态");
        }
      }, []);

      React.useEffect(() => {
        load();
        const t = setInterval(load, POLL_MS);
        return () => clearInterval(t);
      }, [load]);

      const online = accounts.filter((a) => a.online).length;
      const total = accounts.length;
      const allUp = total > 0 && online === total;
      const down = total > 0 && online === 0;
      const color = total === 0 ? "var(--dsw-alias-label-tertiary, #8a8a96)"
        : allUp ? "#3fb950" : down ? "#f85149" : "#d29922";

      async function startAll() {
        if (busy) return;
        setBusy(true);
        try {
          const r = await fetch(START_URL, { method: "POST" });
          const j = await r.json();
          setNote(j && j.ok ? (j.started ? "已拉起，等它连上" : (j.reason || "")) : ((j && j.error) || "启动失败"));
          setTimeout(load, 4000);
        } catch (e) { setNote("启动失败"); } finally { setBusy(false); }
      }

      async function openFishtalk(e) {
        if (e && e.stopPropagation) e.stopPropagation();
        setNote("拉鱼塘…");
        try {
          const r = await fetch(FISHTALK_URL, { method: "POST" });
          const j = await r.json();
          setNote(j && j.ok ? (j.started ? "鱼塘拉起来了" : "鱼塘已经开着") : ((j && j.error) || "拉不起来"));
        } catch (err) {
          setNote("拉不起来");
        }
        setTimeout(() => setNote(""), 4000);
      }

      const summary = total === 0 ? "QQ 0/0" : "QQ " + online + "/" + total;

      const row = (a) => h("div", {
        key: a.id,
        onClick: (e) => { e.stopPropagation(); if (!a.online) startAll(); },
        title: a.online ? (a.nickname || "在线") : "掉线，点一下拉起来",
        style: {
          display: "flex", alignItems: "center", gap: "8px",
          padding: "6px 10px", borderRadius: "6px",
          cursor: a.online ? "default" : "pointer",
          fontSize: FONT,
        },
      },
        Dot(a.online ? "#3fb950" : "#f85149", 7),
        h("span", { style: { opacity: 0.65, minWidth: "38px" } }, a.label || a.id),
        // 名字自己起的、昵称是 QQ 那边的，一样的时候别显示两遍
        h("span", { style: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
          (a.nickname && a.nickname !== (a.label || a.id))
            ? a.nickname
            : (a.online ? "" : "掉线")),
      );

      const panel = (open && total > 0) ? h("div", {
        style: {
          position: "absolute", bottom: "100%", left: "0", marginBottom: "6px",
          minWidth: "200px", padding: "4px",
          border: BORDER, borderRadius: "8px",
          background: "var(--dsw-alias-bg-l1, #1b1b1f)",
          boxShadow: "0 6px 20px rgba(0,0,0,.35)",
          zIndex: 30,
        },
      },
        accounts.map(row),
        note ? h("div", { style: { padding: "4px 10px 6px", fontSize: "11px", opacity: 0.6 } }, note) : null,
        h("div", {
          style: {
            display: "flex", alignItems: "center",
            padding: "3px 8px 3px",
            borderTop: BORDER, marginTop: "3px",
          },
        },
          h("span", {
            role: "button",
            title: "浏览器打开鱼塘控制台",
            onClick: openFishtalk,
            style: {
              marginLeft: "auto", fontSize: "11px", opacity: 0.55,
              cursor: "pointer", padding: "2px 4px", borderRadius: "4px",
            },
          }, "鱼塘"),
        ),
      ) : null;

      return h("div", { style: { position: "relative" } },
        h("button", {
          type: "button",
          disabled: busy,
          onClick: () => setOpen((v) => !v),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          title: allUp ? "QQ 网关：全部在线" : "QQ 网关：" + online + "/" + total + " 在线，点开看是谁掉了",
          style: {
            display: "flex", alignItems: "center", justifyContent: wide ? "flex-start" : "center",
            gap: "7px", width: wide ? "auto" : "32px", height: "32px",
            padding: wide ? "6px 10px" : "6px",
            border: "1px solid transparent", borderRadius: "8px",
            background: hover ? "var(--dsw-color-fill-secondary, rgba(127,127,127,.14))" : "transparent",
            color: "inherit", font: "inherit", fontSize: FONT, lineHeight: "1.4",
            cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
          },
        },
          Dot(color),
          wide ? h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, summary) : null,
          wide ? h("span", { style: { opacity: 0.5, fontSize: "9px", transform: open ? "rotate(180deg)" : "none", display: "inline-block" } }, "▾") : null,
        ),
        panel,
      );
    }


    // ---- 设置页 ----
    // 一张卡一个连接：名字、绑哪个 QQ、投进哪个对话、主人的号、两个白名单。
    // 保存走 /api/save，宿主用 configEditor 写回 profile patch，插件按正常生命周期重载。
    // 也就是说存的瞬间三个号会断一下再连回来，这是预期，不是坏了。

    const FIELD_LABEL = { display: "block", fontSize: "11px", opacity: 0.62, marginBottom: "3px" };
    const FIELD_HINT = { fontSize: "11px", opacity: 0.5, marginTop: "3px", lineHeight: "1.5" };
    const INPUT = {
      width: "100%", boxSizing: "border-box",
      padding: "5px 8px", fontSize: "12px",
      border: "1px solid var(--dsw-alias-border-l1, rgba(120,120,140,0.3))",
      borderRadius: "6px",
      background: "var(--dsw-alias-bg-l2, rgba(127,127,127,0.06))",
      color: "inherit", font: "inherit",
    };
    // 原生下拉的弹层不吃父级颜色，白底白字就是这么来的：
    // color-scheme 让浏览器按深色画原生控件，option 再自己标一遍底和字，双保险。
    const SELECT = {
      ...INPUT,
      colorScheme: "dark",
    };
    const OPTION = {
      background: "var(--dsw-alias-bg-l1, #1c1c20)",
      color: "var(--dsw-alias-label-primary, #e8e8ee)",
    };
    const CARD = {
      border: "1px solid var(--dsw-alias-border-l1, rgba(120,120,140,0.22))",
      borderRadius: "10px", padding: "12px 14px",
      display: "flex", flexDirection: "column", gap: "10px",
    };
    const BTN = {
      padding: "5px 14px", fontSize: "12px", borderRadius: "7px",
      border: "1px solid var(--dsw-alias-border-l1, rgba(120,120,140,0.3))",
      background: "var(--dsw-color-fill-secondary, rgba(127,127,127,0.12))",
      color: "inherit", font: "inherit", cursor: "pointer",
    };
    const BTN_GHOST = { ...BTN, background: "transparent", opacity: 0.8 };

    function SettingsField(title, node, hint) {
      return h("label", { style: { display: "block" } },
        h("span", { style: FIELD_LABEL }, title),
        node,
        hint ? h("div", { style: FIELD_HINT }, hint) : null,
      );
    }

    function AccountCard(props) {
      const acc = props.acc;
      const v = props.v || {};
      const set = (key, value) => props.onChange(acc.id, key, value);
      const actual = acc.selfId
        ? "实际连的是 " + acc.selfId + (acc.nickname ? "（" + acc.nickname + "）" : "")
        : (acc.online ? "已连上，读不到号" : "还没连上");
      const mismatch = v.uin && acc.selfId && String(v.uin) !== String(acc.selfId);

      return h("div", { style: CARD },
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px" } },
          Dot(acc.online ? "#3fb950" : "#f85149", 7),
          h("span", { style: { fontWeight: 600, fontSize: "13px" } }, acc.id),
          h("span", { style: { opacity: 0.55, fontSize: "11px" } }, acc.httpUrl),
        ),
        SettingsField("侧边栏上叫什么",
          h("input", {
            style: INPUT, value: v.label || "", placeholder: acc.id,
            onChange: (e) => set("label", e.target.value),
          }),
          "留空就用 " + acc.id),
        SettingsField("关联 QQ 号",
          h("input", {
            style: INPUT, value: v.uin || "", placeholder: acc.selfId || "填这个连接对应的 QQ 号",
            onChange: (e) => set("uin", e.target.value),
          }),
          "只能填一个。" + (mismatch ? actual + "，跟你填的对不上" : actual) +
            "。填这个连接该是哪个号，对不上会标出来——省得端口接错，消息串进别人的会话"),
        SettingsField("关联对话",
          h("select", {
            style: SELECT, value: v.session || "",
            onChange: (e) => set("session", e.target.value),
          },
            h("option", { value: "", style: OPTION }, "（选一个会话）"),
            v.session && !props.sessions.some((s) => s.id === v.session)
              ? h("option", { value: v.session, style: OPTION }, v.session + "（盘上也找不到）")
              : null,
            props.sessions.map((s) => h("option", { key: s.id, value: s.id, style: OPTION },
              (s.title || "未命名") + " · " + String(s.id).slice(-8) + (s.live ? "" : "（没开着）"))),
          ),
          "投消息要求这条对话是开着的。标了「没开着」的也能选，但要等它打开才投得进去"),
        SettingsField("主人的 QQ 号",
          h("input", {
            style: INPUT, value: v.owner || "", placeholder: "100000000",
            onChange: (e) => set("owner", e.target.value),
          }),
          "只能填一个。只有这个号说的话算指令，其余标成外人"),
        SettingsField("私聊白名单",
          h("input", {
            style: INPUT, value: v.privateList || "", placeholder: "逗号分隔，例：100000000",
            onChange: (e) => set("privateList", e.target.value),
          }),
          "多个用逗号隔开，顿号、分号、空格也认。空着就是谁都不理"),
        SettingsField("群聊白名单",
          h("input", {
            style: INPUT, value: v.groupsList || "", placeholder: "逗号分隔，例：100000001",
            onChange: (e) => set("groupsList", e.target.value),
          }),
          "多个用逗号隔开，顿号、分号、空格也认。空着就是哪个群都不理"),
      );
    }

    function QqGatewaySettings() {
      const [accounts, setAccounts] = React.useState(null);
      const [sessions, setSessions] = React.useState([]);
      const [draft, setDraft] = React.useState({});
      const [note, setNote] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [editorReady, setEditorReady] = React.useState(true);
      const [wake, setWake] = React.useState({ enabled: true, probabilityPercent: 0, intervalMin: 10, guidance: "", contextCount: 3, contextChars: 6000 });

      const load = React.useCallback(async () => {
        try {
          const [a, b] = await Promise.all([
            fetch(STATUS_URL, { cache: "no-store" }).then((r) => r.json()),
            fetch(SESSIONS_URL, { cache: "no-store" }).then((r) => r.json()).catch(() => ({ ok: false, sessions: [] })),
          ]);
          if (!a || !a.ok) { setNote((a && a.error) || "读不到状态"); return; }
          setAccounts(Array.isArray(a.accounts) ? a.accounts : []);
          setEditorReady(a.editor !== false);
          if (a.wake) setWake(a.wake);
          const next = {};
          for (const acc of a.accounts || []) {
            next[acc.id] = {
              label: acc.label || "",
              uin: acc.uin || "",
              session: acc.session || "",
              owner: acc.owner || "",
              privateList: ((acc.allow && acc.allow.private) || []).join(", "),
              groupsList: ((acc.allow && acc.allow.groups) || []).join(", "),
            };
          }
          setDraft(next);
          setNote("");
          if (b && b.ok) setSessions(Array.isArray(b.sessions) ? b.sessions : []);
        } catch (e) {
          setNote("读不到状态");
        }
      }, []);

      React.useEffect(() => { load(); }, [load]);

      const change = React.useCallback((id, key, value) => {
        setDraft((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), [key]: value } }));
      }, []);

      async function save() {
        if (busy) return;
        setBusy(true);
        setNote("存…");
        try {
          const payload = {
            // 这三项是全局的，一份管三个号，跟账号那句分开提。
            // 关着的时候只提交 enabled：下面那几项这会儿是灰的、改不了，
            // 一并提交等于拿打开页面时读的旧值去覆盖别人刚改的。
            wake: wake.enabled === false
              ? { enabled: false }
              : {
                enabled: true,
                probabilityPercent: wake.probabilityPercent,
                intervalMin: wake.intervalMin,
                guidance: wake.guidance,
                contextCount: wake.contextCount,
                contextChars: wake.contextChars,
              },
            accounts: Object.entries(draft).map(([id, v]) => ({
              id,
              label: v.label,
              uin: v.uin,
              session: v.session,
              owner: v.owner,
              private: v.privateList,
              groups: v.groupsList,
            })),
          };
          const r = await fetch(SAVE_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
          const j = await r.json();
          if (j && j.ok) {
            setNote("存好了，三个号会重连一下");
            setTimeout(load, 3000);
          } else {
            setNote((j && j.error) || "存失败");
          }
        } catch (e) {
          setNote("存失败");
        } finally {
          setBusy(false);
        }
      }

      return h("div", { style: { display: "flex", flexDirection: "column", gap: "14px", maxWidth: "620px" } },
        h("div", { style: { fontSize: "12px", opacity: 0.65, lineHeight: "1.7" } },
          "这里的每一个就是侧边栏那个面板里的一行。改完点保存，直接写进 profile 配置并立刻重连——那几秒收不到消息。"),
        h("div", { style: CARD },
          h("div", { style: { display: "flex", alignItems: "baseline", gap: "8px" } },
            h("span", { style: { fontWeight: 600, fontSize: "13px" } }, "群聊唤醒"),
            h("span", { style: { opacity: 0.5, fontSize: "11px" } }, "这一块不按号分，一份管三个号")),
          h("label", { style: { display: "flex", alignItems: "center", gap: "8px", cursor: "pointer" } },
            h("input", {
              type: "checkbox",
              checked: wake.enabled !== false,
              onChange: (e) => setWake((w) => ({ ...w, enabled: e.target.checked })),
              style: { width: "14px", height: "14px", cursor: "pointer", accentColor: "#3fb950" },
            }),
            h("span", { style: { fontSize: "12px" } }, "开启概率唤醒"),
            h("span", { style: { fontSize: "11px", opacity: 0.55 } },
              wake.enabled !== false
                ? "按下面的概率和间隔自己醒"
                : "一条都不掷，只有被点名、被拍、被引用时才醒")),
          // 开关关着的时候整组变灰、点不动。下面这几项只有开着才有意义，
          // 留着能改反而会让人以为改了有用——实际一条都不会掷。
          h("div", {
            style: {
              display: "flex", flexDirection: "column", gap: "10px",
              ...(wake.enabled === false
                ? { opacity: 0.35, pointerEvents: "none", userSelect: "none" }
                : {}),
            },
          },
          SettingsField("没被点名时，每条消息醒过来的概率",
            h("input", {
              type: "number", min: 0, max: 100, step: 1, style: INPUT,
              disabled: wake.enabled === false,
              value: wake.probabilityPercent ?? 0,
              onChange: (e) => setWake((w) => ({ ...w, probabilityPercent: e.target.value })),
            }),
            "单位百分比。0 就是从不，10 是十条里挑一条。醒归醒，说不说照下面那条"),
          SettingsField("一直有人说话时，最多攒多久必须投一次",
            h("input", {
              type: "number", min: 0, max: 1440, step: 1, style: INPUT,
              disabled: wake.enabled === false,
              value: wake.intervalMin ?? 10,
              onChange: (e) => setWake((w) => ({ ...w, intervalMin: e.target.value })),
            }),
            "单位分钟。群里再热闹，攒满这段时间也必须投一次"),
          SettingsField("醒的时候最多带前几条",
            h("input", {
              type: "number", min: 0, max: 200, step: 1, style: INPUT,
              disabled: wake.enabled === false,
              value: wake.contextCount ?? 3,
              onChange: (e) => setWake((w) => ({ ...w, contextCount: e.target.value })),
            }),
            "只带最近的几条。攒了一天的闲聊不全塞，不然一次比每条都投还贵"),
          SettingsField("最多带多少字",
            h("input", {
              type: "number", min: 0, max: 200000, step: 100, style: INPUT,
              disabled: wake.enabled === false,
              value: wake.contextChars ?? 6000,
              onChange: (e) => setWake((w) => ({ ...w, contextChars: e.target.value })),
            }),
            "跟上面那条双卡，哪个先超就按哪个丢"),
          SettingsField("醒过来之后怎么做",
            h("textarea", {
              rows: 3,
              disabled: wake.enabled === false,
              placeholder: "例：看见话题想加入就加入，没兴趣当看了一眼，可以沉默",
              style: { ...INPUT, resize: "vertical", lineHeight: "1.6", fontFamily: "inherit" },
              value: wake.guidance ?? "",
              onChange: (e) => setWake((w) => ({ ...w, guidance: e.target.value })),
            }),
            "这段话会拼在唤醒消息的头部下面，每次叫醒都带上"),
          ),
        ),
        accounts === null
          ? h("div", { style: { fontSize: "12px", opacity: 0.6 } }, "读取中…")
          : accounts.length === 0
            ? h("div", { style: { fontSize: "12px", opacity: 0.6 } }, "没有账号")
            : accounts.map((acc) => h(AccountCard, {
              key: acc.id, acc, v: draft[acc.id] || {}, sessions, onChange: change,
            })),
        h("div", { style: { display: "flex", alignItems: "center", gap: "10px" } },
          h("button", { type: "button", onClick: save, disabled: busy, style: BTN }, busy ? "存…" : "保存"),
          h("button", { type: "button", onClick: load, disabled: busy, style: BTN_GHOST }, "撤回改动"),
          note ? h("span", { style: { fontSize: "11px", opacity: 0.65 } }, note) : null,
        ),
        editorReady ? null : h("div", { style: { fontSize: "11px", color: "#d29922" } },
          "配置编辑服务没起来，保存会失败。看 profile 里 config-editor 那一条。"),
      );
    }

    function apply(ctx) {
      // 必须显式要 slots：cordis 只对 inject 里列出的服务建依赖图，
      // 空数组时 fiber 停在 loading，apply 根本不会被调用（2026-11-15 实测）。
      const slots = (typeof ctx.get === "function" ? ctx.get("slots") : undefined) || ctx.slots;
      if (!slots) return;
      ctx.effect(() =>
        slots.inject("sidebar.footer.action", () =>
          slots.register({ name: "sidebar.footer.action", id: NS }, QqGatewayEntry),
          "qq-gateway: 侧边栏状态按钮",
        ),
        "qq-gateway: 侧边栏状态按钮",
      );
      ctx.effect(() =>
        slots.inject("settings.section", () =>
          slots.register({ name: "settings.section", id: SETTINGS_NS, order: 58, label: "QQ 网关" }, () => h(QqGatewaySettings)),
          "qq-gateway: 设置页",
        ),
        "qq-gateway: 设置页",
      );
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    exports.QqGatewayEntry = QqGatewayEntry;
    return module.exports;
  },
});
