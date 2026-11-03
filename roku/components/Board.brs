sub init()
    m.c = Colors()
    m.rows = m.top.findNode("rows")
    m.lamp = m.top.findNode("lamp")
    m.counts = m.top.findNode("counts")
    m.clock = m.top.findNode("clock")
    m.more = m.top.findNode("more")
    m.empty = m.top.findNode("empty")
    m.offline = m.top.findNode("offline")
    m.banner = m.top.findNode("banner")
    m.pill = m.top.findNode("pill")
    m.bannerText = m.top.findNode("bannerText")
    m.bannerAnim = m.top.findNode("bannerAnim")
    m.bannerMove = m.top.findNode("bannerMove")
    m.detail = m.top.findNode("detail")
    m.detailBody = m.top.findNode("detailBody")
    m.chime = m.top.findNode("chime")
    m.tick = m.top.findNode("tick")
    m.bannerTimer = m.top.findNode("bannerTimer")
    m.focusTimer = m.top.findNode("focusTimer")
    m.stage = m.top.findNode("stage")
    m.muteNote = m.top.findNode("muteNote")
    m.shiftTimer = m.top.findNode("shiftTimer")
    m.noteTimer = m.top.findNode("noteTimer")
    m.slide = m.top.findNode("slide")
    m.slideTimer = m.top.findNode("slideTimer")
    m.browseTimer = m.top.findNode("browseTimer")

    title = m.top.findNode("title")
    title.font = MakeFont(44, true)
    m.counts.font = MakeFont(30)
    m.counts.translation = [title.translation[0] + title.boundingRect().width + 24, 66]
    m.clock.font = MakeFont(40)
    m.more.font = MakeFont(30)
    m.empty.font = MakeFont(48)
    m.offline.font = MakeFont(24)
    m.muteNote.font = MakeFont(26)
    m.bannerText.font = MakeFont(32, true)
    m.top.findNode("detailHint").font = MakeFont(26)
    buildSlide()

    m.focusRing = m.rows.createChild("Poster")
    m.focusRing.uri = "pkg:/images/card-focus.9.png"
    m.focusRing.visible = false

    chime = CreateObject("roSGNode", "ContentNode")
    chime.url = "pkg:/sounds/chime.m4a"
    chime.streamFormat = "mp4"
    m.chime.content = chime

    m.span = CreateObject("roTimespan")
    m.rowNodes = {}
    m.sinceById = {}
    m.shownIds = []
    m.status = invalid
    m.relayNow = 0
    m.fetchedMs = 0
    m.failures = 0
    m.seen = {}
    m.first = true
    m.focus = -1
    m.openId = ""
    m.slideIds = []
    m.slideId = ""
    m.browsing = false

    m.tick.observeField("fire", "onTick")
    m.bannerTimer.observeField("fire", "hideBanner")
    m.focusTimer.observeField("fire", "clearFocus")
    m.shiftTimer.observeField("fire", "shiftStage")
    m.noteTimer.observeField("fire", "showMuteNote")
    m.slideTimer.observeField("fire", "nextSlide")
    m.browseTimer.observeField("fire", "stopBrowsing")
    m.shifts = [[0, 0], [10, 6], [-8, 10], [12, -6], [-10, -8], [4, 12], [-12, 2], [8, -10]]
    m.shift = 0
    m.shiftTimer.control = "start"
    m.registry = CreateObject("roRegistrySection", "handler")
    m.muted = m.registry.Read("muted") = "1"
    showMuteNote()
    m.top.setFocus(true)
end sub

sub onRelayUrl()
    if m.task <> invalid
        m.task.unobserveField("status")
        m.task.control = "stop"
        m.rows.removeChildrenIndex(m.rows.getChildCount(), 0)
        m.rowNodes = {}
    end if
    m.task = CreateObject("roSGNode", "StatusTask")
    m.task.url = m.top.relayUrl + "/status"
    m.task.observeField("status", "onStatus")
    m.task.control = "run"
    m.tick.control = "start"
    onTick()
end sub

sub onPoke()
    if m.task <> invalid then m.task.poke = m.top.poke
end sub

function relayNow() as integer
    return m.relayNow + (m.span.TotalMilliseconds() - m.fetchedMs) \ 1000
end function

function ageOf(iso as dynamic) as integer
    return relayNow() - IsoSeconds(iso)
end function

sub onStatus()
    result = m.task.status
    if result = invalid then return
    if not result.ok
        m.failures = m.failures + 1
        print "HANDLER: status failed "; result.error
        if m.failures >= 3
            m.offline.text = "Can't reach Handler relay at " + m.top.relayUrl + " (" + AsText(result.error) + ")"
            m.offline.visible = true
            m.rows.opacity = 0.5
            if m.status = invalid
                m.empty.text = "Waiting for the Handler relay at " + m.top.relayUrl
                m.empty.visible = true
            end if
        end if
        return
    end if
    m.failures = 0
    m.offline.visible = false
    m.rows.opacity = 1.0
    m.status = result.data
    m.relayNow = IsoSeconds(m.status.now)
    m.fetchedMs = m.span.TotalMilliseconds()
    alertNew()
    render()
    if not m.noting then showMuteNote()
end sub

function fitRows(sessions as object, height as integer) as object
    featuredId = PickFeatured(sessions)
    used = 0
    shown = []
    for i = 0 to sessions.Count() - 1
        s = sessions[i]
        cost = RowHeight(s.state, s.id = featuredId)
        gap = 0
        if shown.Count() > 0 then gap = 16
        reserve = 0
        if i + 1 < sessions.Count() then reserve = 16 + 56
        if used + gap + cost + reserve > height and shown.Count() > 0 then exit for
        used = used + gap + cost
        shown.Push(s)
    end for
    return shown
end function

sub render()
    sessions = m.status.sessions
    shown = fitRows(sessions, 872)
    featuredId = PickFeatured(sessions)
    hosts = {}
    for each s in sessions
        hosts[ShortHost(s.host)] = true
    end for
    manyHosts = hosts.Count() > 1
    m.manyHosts = manyHosts
    keep = {}
    m.shownIds = []
    y = 0
    for each s in shown
        id = s.id
        node = m.rowNodes[id]
        if node = invalid
            node = CreateObject("roSGNode", "SessionRow")
            node.relayUrl = m.top.relayUrl
            m.rows.insertChild(node, 0)
            m.rowNodes[id] = node
        end if
        compact = IsCompact(s.state)
        node.elapsed = ageOf(s.since)
        node.compact = compact
        featured = id = featuredId
        node.featured = featured
        s.where = ""
        if manyHosts then s.where = ShortHost(s.host)
        node.session = s
        node.ago = FormatAgo(ageOf(s.since))
        node.translation = [0, y]
        m.sinceById[id] = s.since
        keep[id] = true
        m.shownIds.Push(id)
        y = y + RowHeight(s.state, featured) + 16
    end for
    for each id in m.rowNodes.Keys()
        if not keep.DoesExist(id)
            m.rows.removeChild(m.rowNodes[id])
            m.rowNodes.Delete(id)
            m.sinceById.Delete(id)
        end if
    end for

    m.more.visible = shown.Count() < sessions.Count()
    if m.more.visible
        m.more.text = "+" + (sessions.Count() - shown.Count()).ToStr() + " more"
        m.more.translation = [72, 152 + y + 8]
    end if
    m.empty.text = "No agents running"
    m.empty.visible = sessions.Count() = 0

    needs = 0
    working = 0
    waiting = 0
    for each s in sessions
        if s.needsYou = true then needs = needs + 1
        if s.state = "working" then working = working + 1
        if s.state = "waiting" then waiting = waiting + 1
    end for
    parts = []
    if needs > 0 then parts.Push(needs.ToStr() + " need you")
    if working > 0 then parts.Push(working.ToStr() + " working")
    if waiting > 0 then parts.Push(waiting.ToStr() + " waiting")
    m.counts.text = parts.Join(" · ")
    if needs > 0 then m.lamp.uri = "pkg:/images/lamp-red.png" else m.lamp.uri = "pkg:/images/lamp-grey.png"

    if m.focus >= m.shownIds.Count() then m.focus = m.shownIds.Count() - 1
    showFocus()
    updateSlides(needs = 0 and working = 0)
    if m.openId <> "" then showDetail(m.openId)
end sub

sub onTick()
    now = CreateObject("roDateTime")
    now.ToLocalTime()
    m.clock.text = FormatClock(now)
    if m.status = invalid then return
    for each id in m.rowNodes.Keys()
        m.rowNodes[id].ago = FormatAgo(ageOf(m.sinceById[id]))
    end for
    if m.slide.visible then showSlideAgo()
end sub

sub alertNew()
    current = {}
    for each s in m.status.sessions
        if s.needsYou = true
            key = s.id + "|" + AsText(s.since)
            current[key] = true
            if not m.first and not m.seen.DoesExist(key) then showBanner(s)
        end if
    end for
    m.seen = current
    m.first = false
end sub

sub showBanner(s as object)
    what = "needs you"
    if type(s.question) = "roAssociativeArray"
        what = "has a question for you"
    else if AsText(s.detail) <> ""
        what = AsText(s.detail).Replace("Needs permission: ", "wants to run ")
        what = CreateObject("roRegex", " \(([^()]+)\)$", "").Replace(what, " (subagent)")
        if what = "Needs permission" then what = "needs permission"
    end if
    m.bannerText.width = 0
    m.bannerText.text = AsText(s.project) + " " + what
    textWidth = m.bannerText.boundingRect().width
    if textWidth > 1380
        textWidth = 1380
        m.bannerText.width = 1380
    end if
    width = textWidth + 78 + 40
    m.pill.width = width
    x = (1920 - width) / 2
    m.banner.visible = true
    m.bannerMove.keyValue = [[x, -140], [x, 28]]
    m.bannerAnim.control = "start"
    m.bannerTimer.control = "stop"
    m.bannerTimer.control = "start"
    if not m.muted and m.status.quiet <> true
        m.chime.control = "stop"
        m.chime.control = "play"
    end if
    print "HANDLER: banner "; m.bannerText.text
end sub

sub hideBanner()
    t = m.banner.translation
    m.bannerMove.keyValue = [[t[0], t[1]], [t[0], -140]]
    m.bannerAnim.control = "start"
end sub

sub showFocus()
    if m.focus < 0 or m.focus >= m.shownIds.Count()
        m.focusRing.visible = false
        return
    end if
    node = m.rowNodes[m.shownIds[m.focus]]
    height = RowHeight(AsText(node.session.state), node.featured)
    m.focusRing.width = 1776 + 8
    m.focusRing.height = height + 8
    m.focusRing.translation = [node.translation[0] - 4, node.translation[1] - 4]
    m.focusRing.visible = true
    m.rows.removeChild(m.focusRing)
    m.rows.appendChild(m.focusRing)
end sub

sub clearFocus()
    m.focus = -1
    showFocus()
end sub

function findSession(id as string) as dynamic
    if m.status = invalid then return invalid
    for each s in m.status.sessions
        if s.id = id then return s
    end for
    return invalid
end function

sub addDetail(text as string, size as integer, color as string, lines = 1 as integer, bold = false as boolean)
    label = MakeLabel(m.detailBody, size, color, bold)
    label.width = 1728
    label.wrap = lines > 1
    label.maxLines = lines
    label.lineSpacing = 4
    label.text = text
end sub

sub addSection(title as string, text as string, lines = 1 as integer)
    if text = "" then return
    addDetail(UCase(title), 24, m.c.dim)
    addDetail(text, 30, m.c.text, lines)
end sub

function plainText(text as string) as string
    text = CreateObject("roRegex", "\*\*([^*]+)\*\*", "").ReplaceAll(text, "\1")
    text = CreateObject("roRegex", "`([^`]+)`", "").ReplaceAll(text, "\1")
    text = CreateObject("roRegex", "(^|\n)\s*[-*]\s+", "").ReplaceAll(text, "\1• ")
    return CreateObject("roRegex", "\n{3,}", "").ReplaceAll(text, Chr(10) + Chr(10))
end function

sub showDetail(id as string)
    s = findSession(id)
    if s = invalid
        closeDetail()
        return
    end if
    m.openId = id
    while m.detailBody.getChildCount() > 0
        m.detailBody.removeChildIndex(0)
    end while

    title = AsText(s.project)
    if AsText(s.branch) <> "" then title = title + "  ·  " + AsText(s.branch)
    addDetail(title, 52, m.c.text, 1, true)
    started = CreateObject("roDateTime")
    started.FromSeconds(IsoSeconds(s.started))
    started.ToLocalTime()
    detail = AsText(s.detail)
    if detail = "" then detail = StateText(s.state)
    if s.state = "waiting" then detail = WaitingDetail(s)
    meta = "started " + FormatClock(started)
    if detail <> "" then meta = detail + "  ·  " + meta
    if AsText(s.host) <> "" then meta = meta + "  ·  " + AsText(s.host)
    addDetail(meta, 30, m.c.dim)

    if type(s.question) = "roAssociativeArray"
        options = ""
        if type(s.question.options) = "roArray" then options = Chr(10) + s.question.options.Join("  ·  ")
        addSection("Question", AsText(s.question.text) + options, 4)
    end if
    addSection("Summary", AsText(s.summary), 2)
    if type(s.todo) = "roAssociativeArray"
        tasks = AsText(s.todo.done) + " of " + AsText(s.todo.total) + " done"
        if AsText(s.todo.current) <> "" then tasks = tasks + "  ·  now: " + AsText(s.todo.current)
        addSection("Tasks", tasks)
    end if
    if type(s.subagentList) = "roArray" and s.subagentList.Count() > 0
        subs = []
        for each a in s.subagentList
            subs.Push("• " + AsText(a.type) + ": " + AsText(a.description) + " (" + StateText(AsText(a.state)) + ")")
        end for
        addSection("Subagents", subs.Join(Chr(10)), 4)
    end if
    if AsText(s.lastMessage) <> "" then addSection("Last message", plainText(AsText(s.lastMessage)), 8)
    if type(s.activity) = "roArray" and s.activity.Count() > 0
        lines = []
        for each a in s.activity
            if lines.Count() < 8
                if Left(a, 2) = "↳ " then a = "› subagent: " + Mid(a, 3)
                lines.Push("• " + a)
            end if
        end for
        addSection("Recent activity", lines.Join(Chr(10)), 8)
    end if
    m.detail.visible = true
end sub

sub closeDetail()
    m.openId = ""
    m.detail.visible = false
end sub

sub shiftStage()
    m.shift = (m.shift + 1) mod m.shifts.Count()
    m.stage.translation = m.shifts[m.shift]
end sub

sub toggleMute()
    m.muted = not m.muted
    if m.muted then m.registry.Write("muted", "1") else m.registry.Write("muted", "0")
    m.registry.Flush()
    m.muteNote.text = "Chime on"
    if m.muted then m.muteNote.text = "Chime off"
    m.muteNote.color = m.c.text
    m.noting = true
    m.noteTimer.control = "stop"
    m.noteTimer.control = "start"
    if not m.muted
        m.chime.control = "stop"
        m.chime.control = "play"
    end if
    print "HANDLER: muted "; m.muted
end sub

sub showMuteNote()
    m.noting = false
    m.muteNote.color = m.c.dim
    m.muteNote.text = ""
    if m.muted
        m.muteNote.text = "Chime off  (* to turn on)"
    else if m.status <> invalid and m.status.quiet = true
        m.muteNote.text = "Quiet hours"
    end if
end sub

function onKeyEvent(key as string, press as boolean) as boolean
    if not press then return false
    if key = "options"
        toggleMute()
        return true
    end if
    if m.slide.visible and m.openId = ""
        if key = "left" or key = "right"
            delta = 1
            if key = "left" then delta = -1
            stepSlide(delta)
            m.slideTimer.control = "stop"
            m.slideTimer.control = "start"
            return true
        end if
        if key = "OK"
            showDetail(m.slideId)
            return true
        end if
        if key = "up" or key = "down"
            m.browsing = true
            m.browseTimer.control = "stop"
            m.browseTimer.control = "start"
            updateSlides(false)
            return true
        end if
    end if
    if m.browsing then m.browseTimer.control = "stop"
    if m.browsing then m.browseTimer.control = "start"
    if m.openId <> ""
        if key = "back" or key = "OK"
            closeDetail()
            return true
        end if
        return true
    end if
    if key = "down" or key = "up"
        count = m.shownIds.Count()
        if count = 0 then return true
        if m.focus < 0
            m.focus = 0
        else if key = "down"
            m.focus = (m.focus + 1) mod count
        else
            m.focus = (m.focus - 1 + count) mod count
        end if
        showFocus()
        m.focusTimer.control = "stop"
        m.focusTimer.control = "start"
        return true
    end if
    if key = "OK"
        if m.focus < 0 and m.shownIds.Count() > 0 then m.focus = 0
        if m.focus >= 0
            m.focusTimer.control = "stop"
            showDetail(m.shownIds[m.focus])
        end if
        return true
    end if
    return false
end function

sub buildSlide()
    m.slideAvatar = m.slide.createChild("Avatar")
    m.slideAvatar.translation = [0, 0]
    m.slideTitle = MakeLabel(m.slide, 52, m.c.text, true)
    m.slideTitle.width = 1560
    m.slideTitle.translation = [216, 4]
    m.slideMeta = MakeLabel(m.slide, 30, m.c.amber)
    m.slideMeta.width = 1560
    m.slideMeta.translation = [216, 76]
    m.slideSummary = MakeLabel(m.slide, 30, m.c.dim)
    m.slideSummary.width = 1560
    m.slideSummary.wrap = true
    m.slideSummary.maxLines = 2
    m.slideSummary.translation = [216, 124]
    rule = m.slide.createChild("Rectangle")
    rule.color = m.c.line
    rule.width = 1776
    rule.height = 2
    rule.translation = [0, 222]
    m.slideLabel = MakeLabel(m.slide, 24, m.c.dim)
    m.slideLabel.translation = [0, 246]
    m.slideBody = MakeLabel(m.slide, 30, m.c.text)
    m.slideBody.width = 1776
    m.slideBody.height = 540
    m.slideBody.wrap = true
    m.slideBody.lineSpacing = 6
    m.slideBody.translation = [0, 290]
    m.slideFooter = MakeLabel(m.slide, 26, m.c.dim)
    m.slideFooter.width = 1776
    m.slideFooter.horizAlign = "center"
    m.slideFooter.translation = [0, 860]
end sub

sub updateSlides(allWaiting as boolean)
    ids = []
    if not m.browsing and m.status <> invalid
        if m.status.sessions.Count() = 1
            ids.Push(m.status.sessions[0].id)
        else if allWaiting
            for each s in m.status.sessions
                if s.state = "waiting" then ids.Push(s.id)
            end for
        end if
    end if
    m.slideIds = ids
    on = ids.Count() > 0
    if not on
        if m.slide.visible
            m.slide.visible = false
            m.slideTimer.control = "stop"
            m.rows.visible = true
            m.slideId = ""
            print "HANDLER: slideshow off"
        end if
        return
    end if
    if not m.slide.visible
        m.slide.visible = true
        m.rows.visible = false
        m.more.visible = false
        m.focus = -1
        m.slideTimer.control = "start"
        print "HANDLER: slideshow on ("; ids.Count(); ")"
    end if
    m.more.visible = false
    if slideIndex() < 0 then m.slideId = ids[0]
    showSlide()
end sub

function slideIndex() as integer
    for i = 0 to m.slideIds.Count() - 1
        if m.slideIds[i] = m.slideId then return i
    end for
    return -1
end function

sub stepSlide(delta as integer)
    count = m.slideIds.Count()
    if count = 0 then return
    i = slideIndex()
    if i < 0 then i = 0 else i = (i + delta + count) mod count
    m.slideId = m.slideIds[i]
    showSlide()
end sub

sub nextSlide()
    if m.slideIds.Count() > 1 then stepSlide(1)
end sub

sub stopBrowsing()
    m.browsing = false
    if m.status <> invalid then render()
end sub

function slideAnim(s as object) as string
    if s.needsYou = true then return "puzzled"
    if s.state = "working" then return "working"
    if s.state = "stale" then return "bored"
    if s.state = "ended" then return ""
    return "sleeping"
end function

sub setSlideAvatar(s as object, variant as string)
    c = s.character
    if type(c) <> "roAssociativeArray" or type(c.tv) <> "roAssociativeArray"
        m.slideAvatar.visible = false
        return
    end if
    base = m.top.relayUrl + "/characters/" + c.id + "/"
    bubble = ""
    if s.state = "asking" then bubble = "question"
    if s.state = "needs_permission" then bubble = "permission"
    spec = { size: 192, ring: variant, bubble: bubble, cols: c.tv.cols, url: base + c.tv.still, frames: 1, fps: 1, loop: false }
    anim = slideAnim(s)
    if anim <> "" and type(c.states) = "roAssociativeArray" and c.states.DoesExist(anim)
        st = c.states[anim]
        spec.url = base + st.tv
        spec.frames = st.frames
        spec.fps = st.fps
        spec.loop = st.loop
    end if
    m.slideAvatar.spec = spec
    m.slideAvatar.visible = true
end sub

function activityText(s as object, count as integer, skip = "" as string) as string
    lines = []
    if type(s.activity) = "roArray"
        for each a in s.activity
            if lines.Count() < count and a <> skip
                if Left(a, 2) = "↳ " then a = "› subagent: " + Mid(a, 3)
                lines.Push("• " + a)
            end if
        end for
    end if
    return lines.Join(Chr(10))
end function

function slideContent(s as object) as object
    if type(s.question) = "roAssociativeArray"
        text = AsText(s.question.text)
        if type(s.question.options) = "roArray" and s.question.options.Count() > 0
            options = []
            for each o in s.question.options
                options.Push("• " + AsText(o))
            end for
            text = text + Chr(10) + Chr(10) + options.Join(Chr(10))
        end if
        return { label: "QUESTION", text: text }
    end if
    if s.state = "needs_permission"
        text = AsText(s.detail).Replace("Needs permission: ", "").Replace("Needs permission", "")
        recent = activityText(s, 6, text)
        if recent <> "" then text = text + Chr(10) + Chr(10) + "Before that:" + Chr(10) + recent
        return { label: "WANTS TO RUN", text: text }
    end if
    if s.state = "working"
        text = ""
        if type(s.todo) = "roAssociativeArray"
            text = "Tasks: " + AsText(s.todo.done) + " of " + AsText(s.todo.total) + " done"
            if AsText(s.todo.current) <> "" then text = text + "  ·  now: " + AsText(s.todo.current)
            text = text + Chr(10) + Chr(10)
        end if
        if type(s.subagentList) = "roArray" and s.subagentList.Count() > 0
            subs = []
            for each a in s.subagentList
                subs.Push("› " + AsText(a.type) + ": " + AsText(a.description) + " (" + StateText(AsText(a.state)) + ")")
            end for
            text = text + subs.Join(Chr(10)) + Chr(10) + Chr(10)
        end if
        return { label: "RECENT ACTIVITY", text: text + activityText(s, 10) }
    end if
    if AsText(s.lastMessage) <> "" then return { label: "LAST MESSAGE", text: plainText(AsText(s.lastMessage)) }
    return { label: "RECENT ACTIVITY", text: activityText(s, 10) }
end function

sub showSlide()
    s = findSession(m.slideId)
    if s = invalid then return
    variant = CardVariant(s)
    setSlideAvatar(s, variant)
    m.slideTitle.text = AsText(s.project)
    m.slideMeta.color = AccentColor(variant)
    m.slideSummary.text = AsText(s.summary)
    content = slideContent(s)
    m.slideLabel.text = content.label
    body = content.text
    size = 32
    if Len(body) > 1400 then size = 28
    if Len(body) > 2200 then size = 24
    m.slideBody.font = MakeFont(size)
    m.slideBody.color = m.c.text
    if s.needsYou = true then m.slideBody.color = m.c.request
    m.slideBody.text = body
    showSlideAgo()
end sub

sub showSlideAgo()
    s = findSession(m.slideId)
    if s = invalid then return
    age = FormatAgo(ageOf(s.since))
    if s.state = "waiting"
        meta = "Done " + age + " ago"
    else if s.state = "working"
        meta = "Working  ·  " + age
    else if s.needsYou = true
        meta = StateText(s.state) + "  ·  " + age
    else
        meta = StateText(s.state)
    end if
    if AsText(s.branch) <> "" then meta = meta + "  ·  " + AsText(s.branch)
    if AsText(s.folder) <> "" and AsText(s.folder) <> AsText(s.project) then meta = meta + "  ·  " + AsText(s.folder)
    if m.manyHosts = true then meta = meta + "  ·  " + ShortHost(s.host)
    m.slideMeta.text = meta
    count = m.slideIds.Count()
    footer = "OK for details  ·  up or down for the board"
    if count > 1 then footer = (slideIndex() + 1).ToStr() + " of " + count.ToStr() + "  ·  left or right to step  ·  " + footer
    m.slideFooter.text = footer
end sub
