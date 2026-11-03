sub init()
    m.frameBg = m.top.findNode("frame")
    m.clip = m.top.findNode("clip")
    m.sheet = m.top.findNode("sheet")
    m.bubble = m.top.findNode("bubble")
    m.timer = m.top.findNode("timer")
    m.timer.observeField("fire", "onTick")
    m.key = ""
    m.frame = 0
end sub

sub onSpec()
    s = m.top.spec
    if s = invalid then return
    size = s.size
    m.frameBg.uri = "pkg:/images/avatar-" + s.ring + ".9.png"
    m.frameBg.width = size + 8
    m.frameBg.height = size + 8
    m.clip.clippingRect = [0, 0, size, size]

    if s.bubble <> ""
        m.bubble.uri = "pkg:/images/bubble-" + s.bubble + ".png"
        m.bubble.translation = [size - 36, -26]
        m.bubble.visible = true
    else
        m.bubble.visible = false
    end if

    key = s.url + "|" + size.ToStr()
    if key = m.key then return
    m.key = key

    m.size = size
    m.frames = s.frames
    m.loop = s.loop
    m.frameTime = 1.0 / s.fps
    m.rest = 0
    if s.rest <> invalid then m.rest = s.rest
    m.cols = s.cols
    cols = s.cols
    if s.frames < cols then cols = s.frames
    rows = (s.frames + s.cols - 1) \ s.cols
    m.sheet.width = cols * size
    m.sheet.height = rows * size
    m.sheet.loadWidth = cols * size
    m.sheet.loadHeight = rows * size
    m.sheet.uri = s.url

    m.frame = 0
    showFrame()
    m.timer.control = "stop"
    if s.frames > 1
        m.timer.duration = m.frameTime
        m.timer.control = "start"
    end if
end sub

sub onTick()
    m.timer.duration = m.frameTime
    m.frame = m.frame + 1
    if m.frame >= m.frames
        if m.loop
            m.frame = 0
            if m.rest > 0
                m.timer.control = "stop"
                m.timer.duration = m.rest
                m.timer.control = "start"
            end if
        else
            m.frame = m.frames - 1
            m.timer.control = "stop"
        end if
    end if
    showFrame()
end sub

sub showFrame()
    m.sheet.translation = [-(m.frame mod m.cols) * m.size, -(m.frame \ m.cols) * m.size]
end sub
