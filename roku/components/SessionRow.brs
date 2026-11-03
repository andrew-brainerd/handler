sub init()
    m.c = Colors()
    m.width = 1776
    m.bg = m.top.createChild("Poster")
    m.avatar = m.top.createChild("Avatar")

    m.main = m.top.createChild("Group")
    m.line1 = m.main.createChild("Group")
    m.project = MakeLabel(m.line1, 36, m.c.text, true)
    m.branch = MakeLabel(m.line1, 22, m.c.dim)
    m.state = MakeLabel(m.line1, 26, m.c.green, true)

    m.body1 = MakeLabel(m.main, 28, m.c.text)
    m.body1.width = 892
    m.body2 = MakeLabel(m.main, 24, m.c.dim)
    m.body2.width = 892

    m.rule = m.top.createChild("Rectangle")
    m.rule.color = m.c.line
    m.rule.width = 2

    m.activity = m.top.createChild("Group")
    m.lines = []
    for i = 0 to 8
        line = MakeLabel(m.activity, 21, m.c.dim)
        line.width = 498
        m.lines.Push(line)
    end for

    m.agoLabel = MakeLabel(m.top, 26, m.c.dim)
    m.agoLabel.width = 96
    m.agoLabel.horizAlign = "right"
    m.agoLabel.vertAlign = "center"
    m.agoLabel.translation = [1652, 0]
end sub

sub onAgo()
    m.agoLabel.text = m.top.ago
end sub

function splitDetail(s as object) as object
    detail = AsText(s.detail)
    if s.state = "waiting" then return { stateText: WaitingDetail(s), request: "" }
    if s.state <> "needs_permission" or Left(detail, 16) <> "Needs permission"
        if detail = "" then detail = StateText(s.state)
        return { stateText: detail, request: "" }
    end if
    match = CreateObject("roRegex", "^Needs permission(?:: (.*?))?(?: \(([^()]+)\))?$", "").Match(detail)
    stateText = "Needs permission"
    request = ""
    if match.Count() > 2 and match[2] <> "" then stateText = "Needs permission · " + match[2]
    if match.Count() > 1 then request = match[1]
    return { stateText: stateText, request: request }
end function

function spriteState(s as object) as string
    if s.state = "ended" then return ""
    if s.needsYou = true then return "puzzled"
    if s.state = "working" then return "working"
    if s.state = "stale" then return "bored"
    detail = AsText(s.detail)
    if (detail = "You said no" or detail = "Interrupted") and m.top.elapsed < 8 then return "puzzled"
    return "sleeping"
end function

function bubbleFor(s as object) as string
    if s.state = "asking" then return "question"
    if s.state = "needs_permission" then return "permission"
    return ""
end function

sub setAvatar(s as object, variant as string, size as integer, height as integer)
    c = s.character
    if type(c) <> "roAssociativeArray" or type(c.tv) <> "roAssociativeArray"
        m.avatar.visible = false
        return
    end if
    m.avatar.visible = true
    anim = spriteState(s)
    base = m.top.relayUrl + "/characters/" + c.id + "/"
    spec = { size: size, ring: variant, bubble: bubbleFor(s), cols: c.tv.cols, url: base + c.tv.still, frames: 1, fps: 1, loop: false }
    if anim <> "" and type(c.states) = "roAssociativeArray" and c.states.DoesExist(anim)
        st = c.states[anim]
        spec.url = base + st.tv
        spec.frames = st.frames
        spec.fps = st.fps
        spec.loop = st.loop
        spec.rest = st.rest
    end if
    frame = size + 8
    avatarX = 20 + (136 - frame) / 2
    if avatarX < 20 then avatarX = 20
    m.avatar.translation = [avatarX, (height - frame) / 2]
    m.avatar.spec = spec
end sub

sub onSession()
    s = m.top.session
    if s = invalid then return
    compact = m.top.compact
    featured = m.top.featured
    height = RowHeight(s.state, featured)
    variant = CardVariant(s)
    accent = AccentColor(variant)

    m.bg.uri = "pkg:/images/card-" + variant + ".9.png"
    m.bg.width = m.width
    m.bg.height = height
    m.top.opacity = 1.0
    if s.state = "stale" or s.state = "ended" then m.top.opacity = 0.55

    avatarSize = 128
    if compact then avatarSize = 64
    if featured then avatarSize = 192
    setAvatar(s, variant, avatarSize, height)

    parts = splitDetail(s)
    m.project.font = MakeFont(36, true)
    if compact then m.project.font = MakeFont(30, true)
    m.project.text = AsText(s.project)
    branch = AsText(s.branch)
    if Len(branch) > 32 then branch = Left(branch, 31) + "…"
    if AsText(s.where) <> ""
        if branch <> "" then branch = branch + "  ·  "
        branch = branch + AsText(s.where)
    end if
    m.branch.text = branch
    m.branch.visible = branch <> ""
    m.state.text = parts.stateText
    m.state.color = accent

    summary = AsText(s.summary)
    source = AsText(s.summarySource)
    summaryColor = m.c.text
    if source = "prompt" or source = "message" then summaryColor = m.c.dim

    m.body2.visible = false
    m.body1.wrap = false
    m.body1.maxLines = 1
    if type(s.question) = "roAssociativeArray"
        setBody(m.body1, AsText(s.question.text), 28, m.c.request, 1)
        options = []
        if type(s.question.options) = "roArray" then options = s.question.options
        if options.Count() > 0
            setBody(m.body2, options.Join(" · "), 24, m.c.dim, 1)
            m.body2.visible = true
        end if
    else if parts.request <> ""
        setBody(m.body1, parts.request, 28, m.c.request, 1)
        if summary <> ""
            setBody(m.body2, summary, 24, m.c.dim, 1)
            m.body2.visible = true
        end if
    else if compact
        setBody(m.body1, summary, 24, summaryColor, 1)
    else if featured
        setBody(m.body1, summary, 32, summaryColor, 2)
        if AsText(s.output) <> ""
            setBody(m.body2, AsText(s.output), 24, m.c.dim, 5)
            m.body2.visible = true
        else if type(s.todo) = "roAssociativeArray" and AsText(s.todo.current) <> "" and AsText(s.todo.current) <> summary
            setBody(m.body2, "Now: " + AsText(s.todo.current), 24, m.c.dim, 2)
            m.body2.visible = true
        end if
    else
        setBody(m.body1, summary, 28, summaryColor, 2)
    end if
    bodyWidth = 892
    textLeft = 184
    if featured
        bodyWidth = 836
        textLeft = 240
    end if
    m.body1.width = bodyWidth
    m.body2.width = bodyWidth
    m.body1.visible = m.body1.text <> ""
    layoutLine1()
    stack([m.line1, m.body1, m.body2], textLeft, height, 6)

    tags = []
    if type(s.todo) = "roAssociativeArray" then tags.Push(AsText(s.todo.done) + "/" + AsText(s.todo.total) + " tasks")
    if s.subagents <> invalid and s.subagents > 0
        noun = " subagent"
        if s.subagents > 1 then noun = " subagents"
        tags.Push(s.subagents.ToStr() + noun)
    end if
    activity = []
    if type(s.activity) = "roArray" then activity = s.activity
    limit = 3
    if tags.Count() > 0 then limit = 2
    if compact then limit = 1
    if featured
        limit = m.lines.Count()
        if tags.Count() > 0 then limit = limit - 1
    end if
    for i = 0 to m.lines.Count() - 1
        line = m.lines[i]
        line.visible = false
        if i < limit and i < activity.Count()
            text = activity[i]
            line.color = m.c.dim
            if i = 0 then line.color = m.c.text
            if Left(text, 2) = "↳ " then text = "› " + Mid(text, 3)
            line.text = text
            line.visible = true
        end if
    end for
    if tags.Count() > 0 and not compact
        slot = m.lines[limit]
        if activity.Count() < limit then slot = m.lines[activity.Count()]
        slot.text = tags.Join(" · ")
        slot.color = m.c.text
        slot.visible = true
    end if
    stack(m.lines, 1126, height, 4)
    m.rule.height = height - 40
    m.rule.translation = [1104, 20]
    m.agoLabel.height = height
end sub

sub setBody(label as object, text as string, size as integer, color as string, lines as integer)
    label.font = MakeFont(size)
    label.color = color
    label.wrap = lines > 1
    label.maxLines = lines
    label.lineSpacing = 0
    label.text = text
end sub

sub layoutLine1()
    labels = [m.project, m.branch, m.state]
    height = 0
    for each label in labels
        label.translation = [0, 0]
        r = label.boundingRect()
        if r.height > height then height = r.height
    end for
    x = 0
    for each label in labels
        if label.visible and label.text <> ""
            r = label.boundingRect()
            label.translation = [x, height - r.height]
            x = x + r.width + 16
        end if
    end for
end sub

sub stack(items as object, x as integer, height as integer, spacing as integer)
    shown = []
    total = 0
    for each item in items
        if item.visible
            h = item.boundingRect().height
            shown.Push({ node: item, h: h })
            total = total + h
        end if
    end for
    if shown.Count() > 1 then total = total + spacing * (shown.Count() - 1)
    y = (height - total) / 2
    for each entry in shown
        entry.node.translation = [x, y]
        y = y + entry.h + spacing
    end for
end sub
