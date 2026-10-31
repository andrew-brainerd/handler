sub init()
    m.top.functionName = "run"
end sub

sub run()
    port = CreateObject("roMessagePort")
    m.top.observeField("poke", port)
    while true
        m.top.status = fetchStatus()
        Wait(3000, port)
    end while
end sub

function fetchStatus() as object
    port = CreateObject("roMessagePort")
    xfer = CreateObject("roUrlTransfer")
    xfer.SetMessagePort(port)
    xfer.SetUrl(m.top.url)
    xfer.EnableEncodings(true)
    if not xfer.AsyncGetToString() then return { ok: false, error: "Request could not start" }

    msg = Wait(5000, port)
    if msg = invalid
        xfer.AsyncCancel()
        return { ok: false, error: "Timed out" }
    end if

    code = msg.GetResponseCode()
    if code <> 200
        reason = msg.GetFailureReason()
        if code > 0 then reason = "HTTP " + code.ToStr()
        return { ok: false, error: reason }
    end if

    data = ParseJson(msg.GetString())
    if data = invalid or type(data.sessions) <> "roArray" then return { ok: false, error: "Bad status JSON" }
    return { ok: true, data: data }
end function
