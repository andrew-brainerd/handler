sub init()
    m.c = Colors()
    m.bg = m.top.createChild("Poster")
    m.avatar = m.top.createChild("Avatar")
    m.avatar.translation = [14, 4]
    m.kind = MakeLabel(m.top, 24, m.c.text, true)
    m.desc = MakeLabel(m.top, 24, m.c.text)
    m.line = MakeLabel(m.top, 21, m.c.dim)
    m.state = MakeLabel(m.top, 22, m.c.green, true)
    m.state.horizAlign = "right"
    m.state.width = 240
end sub

function subVariant(state as string) as string
    if state = "needs_permission" or state = "asking" then return "alert"
    if state = "working" then return "working"
    return "dim"
end function

function subAnim(state as string) as string
    if state = "needs_permission" or state = "asking" then return "puzzled"
    if state = "working" then return "working"
    return ""
end function

sub setSidekick(a as object, variant as string)
    c = a.character
    if type(c) <> "roAssociativeArray" or type(c.tv) <> "roAssociativeArray"
        m.avatar.visible = false
        return
    end if
    m.avatar.visible = true
    base = m.top.relayUrl + "/characters/" + c.id + "/"
    spec = { size: 56, ring: variant, bubble: "", cols: c.tv.cols, url: base + c.tv.still, frames: 1, fps: 1, loop: false }
    anim = subAnim(AsText(a.state))
    if anim <> "" and type(c.states) = "roAssociativeArray" and c.states.DoesExist(anim)
        st = c.states[anim]
        spec.url = base + st.tv
        spec.frames = st.frames
        spec.fps = st.fps
        spec.loop = st.loop
        spec.rest = st.rest
    end if
    m.avatar.spec = spec
end sub

sub onAgent()
    a = m.top.agent
    if a = invalid then return
    width = m.top.cardWidth
    state = AsText(a.state)
    variant = subVariant(state)
    accent = AccentColor(variant)

    m.bg.uri = "pkg:/images/subcard-" + variant + ".9.png"
    m.bg.width = width
    m.bg.height = SubCardHeight()
    m.top.opacity = 1.0
    if state = "done" then m.top.opacity = 0.55
    setSidekick(a, variant)

    left = 92
    kind = AsText(a.type)
    if kind = "" then kind = "subagent"
    m.kind.text = kind
    m.kind.translation = [left, 6]
    kindWidth = m.kind.boundingRect().width

    m.state.text = StateText(state)
    m.state.color = accent
    m.state.translation = [width - 260, 22]

    descLeft = left + kindWidth + 14
    m.desc.text = AsText(a.description)
    m.desc.width = width - 280 - descLeft
    m.desc.translation = [descLeft, 6]
    m.desc.visible = m.desc.text <> "" and m.desc.width > 40

    m.line.text = AsText(a.line)
    m.line.color = m.c.dim
    if variant = "alert" then m.line.color = m.c.request
    m.line.width = width - 280 - left
    m.line.translation = [left, 38]
end sub
