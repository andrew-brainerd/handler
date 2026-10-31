function Colors() as object
    return {
        text: "0xE8E6E1FF",
        dim: "0x8B8F97FF",
        red: "0xFF4D3DFF",
        amber: "0xF2B33DFF",
        green: "0x4FD18BFF",
        grey: "0x5B6068FF",
        line: "0x262A31FF",
        request: "0xFFD9D4FF",
        bg: "0x0D0F12FF",
    }
end function

function MakeFont(size as integer, bold = false as boolean) as object
    font = CreateObject("roSGNode", "Font")
    if bold
        font.uri = "font:BoldSystemFontFile"
    else
        font.uri = "font:SystemFontFile"
    end if
    font.size = size
    return font
end function

function MakeLabel(parent as object, size as integer, color as string, bold = false as boolean) as object
    label = parent.createChild("Label")
    label.font = MakeFont(size, bold)
    label.color = color
    return label
end function

function IsoSeconds(iso as dynamic) as integer
    if type(iso) <> "roString" and type(iso) <> "String" then return 0
    dt = CreateObject("roDateTime")
    dt.FromISO8601String(Left(iso, 19) + "Z")
    return dt.AsSeconds()
end function

function FormatAgo(seconds as integer) as string
    if seconds < 0 then seconds = 0
    if seconds < 60 then return seconds.ToStr() + "s"
    if seconds < 3600 then return (seconds \ 60).ToStr() + "m"
    return (seconds \ 3600).ToStr() + "h " + ((seconds mod 3600) \ 60).ToStr() + "m"
end function

function FormatClock(dt as object) as string
    hour = dt.GetHours()
    suffix = " AM"
    if hour >= 12 then suffix = " PM"
    hour = hour mod 12
    if hour = 0 then hour = 12
    minutes = dt.GetMinutes().ToStr()
    if Len(minutes) = 1 then minutes = "0" + minutes
    return hour.ToStr() + ":" + minutes + suffix
end function

function StateText(state as string) as string
    names = { working: "Working", waiting: "Done, waiting for you", needs_permission: "Needs permission", asking: "Asked a question", stale: "No activity for 30 min", ended: "Ended" }
    if names.DoesExist(state) then return names[state]
    return state
end function

function IsCompact(state as string) as boolean
    return state = "waiting" or state = "stale" or state = "ended"
end function

function CardVariant(s as object) as string
    if s.needsYou = true then return "alert"
    if s.state = "working" then return "working"
    if s.state = "waiting" then return "waiting"
    return "dim"
end function

function AccentColor(variant as string) as string
    c = Colors()
    if variant = "alert" then return c.red
    if variant = "working" then return c.green
    if variant = "waiting" then return c.amber
    return c.dim
end function

function AsText(value as dynamic) as string
    if type(value) = "roInvalid" or type(value) = "Invalid" or type(value) = "<uninitialized>" then return ""
    t = type(value)
    if t = "roString" or t = "String" then return value
    if t = "roInt" or t = "Integer" or t = "roFloat" or t = "Float" then return value.ToStr()
    return ""
end function
