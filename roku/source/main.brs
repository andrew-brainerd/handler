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
    scene.relayUrl = RelayUrl()

    input = CreateObject("roInput")
    input.SetMessagePort(port)
    pokes = 0

    while true
        msg = Wait(0, port)
        kind = type(msg)
        if kind = "roSGScreenEvent" and msg.IsScreenClosed() then return
        if kind = "roInputEvent"
            info = msg.GetInfo()
            if info <> invalid and info.handler = "alert"
                pokes = pokes + 1
                scene.poke = pokes
                print "HANDLER: ECP alert "; info.seq
            end if
        end if
    end while
end sub
