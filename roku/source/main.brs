sub Main(args as dynamic)
    ShowBoard(false)
end sub

sub RunScreenSaver()
    ShowBoard(true)
end sub

sub ShowBoard(screensaver as boolean)
    screen = CreateObject("roSGScreen")
    port = CreateObject("roMessagePort")
    screen.SetMessagePort(port)
    scene = screen.CreateScene("Board")
    screen.Show()
    scene.screensaver = screensaver
    scene.relayUrl = SavedRelay()

    input = CreateObject("roInput")
    input.SetMessagePort(port)
    pokes = 0
    manager = CreateObject("roAppManager")

    while true
        msg = Wait(30000, port)
        if not screensaver then manager.UpdateLastKeyPressTime()
        kind = type(msg)
        if kind = "roSGScreenEvent" and msg.IsScreenClosed() then return
        if kind = "roInputEvent"
            info = msg.GetInfo()
            if info <> invalid and info.handler = "alert"
                pokes = pokes + 1
                scene.poke = pokes
                print "HANDLER: ECP alert "; info.seq
            else if info <> invalid and info.handler = "relay" and ValidRelay(info.url) and info.url <> scene.relayUrl
                SaveRelay(info.url)
                scene.relayUrl = info.url
                print "HANDLER: relay moved to "; info.url
            end if
        end if
    end while
end sub

function SavedRelay() as string
    section = CreateObject("roRegistrySection", "handler")
    baked = RelayUrl()
    if section.Read("baked") <> baked
        section.Write("baked", baked)
        section.Delete("relay")
        section.Flush()
        return baked
    end if
    saved = section.Read("relay")
    if saved <> "" then return saved
    return baked
end function

sub SaveRelay(url as string)
    section = CreateObject("roRegistrySection", "handler")
    section.Write("relay", url)
    section.Flush()
end sub

function ValidRelay(url as dynamic) as boolean
    if type(url) <> "String" and type(url) <> "roString" then return false
    pattern = CreateObject("roRegex", "^http://(10\.[0-9]+|192\.168|172\.(1[6-9]|2[0-9]|3[01]))\.[0-9]+\.[0-9]+:[0-9]{2,5}$", "")
    return pattern.IsMatch(url)
end function
