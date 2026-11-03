sub init()
    m.c = Colors()
    m.heading = CreateObject("roRegex", "^(#{1,6})\s+(.*)$", "")
    m.item = CreateObject("roRegex", "^(\s*)([-*+]|\d+[.)])\s+(.*)$", "")
    m.fence = CreateObject("roRegex", "^\s*```", "")
    m.quote = CreateObject("roRegex", "^\s*>\s?(.*)$", "")
    m.rule = CreateObject("roRegex", "^\s*(-{3,}|\*{3,}|_{3,})\s*$", "")
    m.tableRow = CreateObject("roRegex", "^\s*\|.*\|\s*$", "")
    m.tableRule = CreateObject("roRegex", "^\s*\|[\s:|-]+\|\s*$", "")
    m.lineBreak = CreateObject("roRegex", "\r?\n", "")
    m.cellBreak = CreateObject("roRegex", "\s*\|\s*", "")
    m.tag = CreateObject("roRegex", "<(/?)(b|code|em|default)>", "i")
    m.code = CreateObject("roRegex", "`([^`]+)`", "")
    m.bold = CreateObject("roRegex", "\*\*(.+?)\*\*", "")
    m.boldAlt = CreateObject("roRegex", "__(.+?)__", "")
    m.em = CreateObject("roRegex", "(^|[^*\w])\*([^*\s][^*]*?)\*", "")
    m.link = CreateObject("roRegex", "\[([^\]]+)\]\([^)\s]+\)", "")
end sub

function inline(text as string) as string
    text = m.tag.ReplaceAll(text, "‹\1\2›")
    text = m.link.ReplaceAll(text, "\1")
    text = m.code.ReplaceAll(text, "<code>\1</code>")
    text = m.bold.ReplaceAll(text, "<b>\1</b>")
    text = m.boldAlt.ReplaceAll(text, "<b>\1</b>")
    return m.em.ReplaceAll(text, "\1<em>\2</em>")
end function

function hex(color as string) as string
    return "#" + Mid(color, 3)
end function

function addText(text as string, x as integer, y as integer, size as integer, color as string, bold = false as boolean, width = 0 as integer) as object
    label = m.top.createChild("MultiStyleLabel")
    regular = "font:SystemFontFile"
    heavy = "font:BoldSystemFontFile"
    base = regular
    if bold then base = heavy
    label.drawingStyles = {
        "default": { "fontSize": size, "fontUri": base, "color": hex(color) },
        "b": { "fontSize": size, "fontUri": heavy, "color": hex(m.c.text) },
        "em": { "fontSize": size, "fontUri": base, "color": hex(m.c.request) },
        "code": { "fontSize": size, "fontUri": base, "color": hex(m.c.green) },
    }
    if width = 0 then width = m.top.viewWidth - x
    label.width = width
    label.wrap = true
    label.lineSpacing = 6
    label.translation = [x, y]
    label.text = text
    return label
end function

function addRect(x as integer, y as integer, width as integer, height as integer, color as string) as object
    rect = m.top.createChild("Rectangle")
    rect.color = color
    rect.width = width
    rect.height = height
    rect.translation = [x, y]
    return rect
end function

function flushParagraph() as integer
    if m.para.Count() = 0 then return 0
    text = m.para.Join(" ")
    m.para = []
    return place(addText(inline(text), 0, m.y, m.top.size, m.top.color), m.top.size \ 2)
end function

function place(node as object, gap as integer) as integer
    h = node.boundingRect().height
    m.y = m.y + h + gap
    return h
end function

function flushCode() as void
    m.y = m.y + 2
    pad = 14
    bg = addRect(0, m.y, m.top.viewWidth, 10, "0x171A1FFF")
    label = m.top.createChild("Label")
    label.font = MakeFont(m.top.size - 4)
    label.color = m.c.text
    label.width = m.top.viewWidth - pad * 2
    label.wrap = true
    label.translation = [pad, m.y + pad]
    label.text = m.codeLines.Join(Chr(10))
    h = label.boundingRect().height
    bg.height = h + pad * 2
    m.y = m.y + h + pad * 2 + m.top.size \ 2
    m.codeLines = []
end function

function addRow(cells as object, header as boolean) as void
    count = cells.Count()
    if count = 0 then return
    gap = 24
    width = (m.top.viewWidth - gap * (count - 1)) \ count
    tallest = 0
    for i = 0 to count - 1
        label = addText(inline(cells[i]), i * (width + gap), m.y, m.top.size - 2, m.top.color, header, width)
        h = label.boundingRect().height
        if h > tallest then tallest = h
    end for
    m.y = m.y + tallest + 6
    if header
        addRect(0, m.y, m.top.viewWidth, 2, m.c.line)
        m.y = m.y + 8
    end if
end function

function tableCells(line as string) as object
    parts = m.cellBreak.Split(line.Trim())
    cells = []
    for each part in parts
        cells.Push(part.Trim())
    end for
    if cells.Count() > 0 and cells[0] = "" then cells.Shift()
    if cells.Count() > 0 and cells[cells.Count() - 1] = "" then cells.Pop()
    return cells
end function

sub addLine(line as string, nextIsRule as boolean)
    match = m.heading.Match(line)
    if match.Count() > 2
        flushParagraph()
        level = Len(match[1])
        grow = 2
        if level = 1 then grow = 10
        if level = 2 then grow = 6
        m.y = m.y + 6
        place(addText(inline(match[2]), 0, m.y, m.top.size + grow, m.c.text, true), m.top.size \ 2)
        return
    end if
    if m.rule.IsMatch(line)
        flushParagraph()
        addRect(0, m.y + 6, m.top.viewWidth, 2, m.c.line)
        m.y = m.y + 22
        return
    end if
    match = m.item.Match(line)
    if match.Count() > 3
        flushParagraph()
        depth = Len(match[1]) \ 2
        if depth > 3 then depth = 3
        x = depth * 36
        mark = match[2]
        if mark = "-" or mark = "*" or mark = "+" then mark = "•"
        addText(mark, x, m.y, m.top.size, m.c.dim)
        place(addText(inline(match[3]), x + 44, m.y, m.top.size, m.top.color), 6)
        return
    end if
    match = m.quote.Match(line)
    if match.Count() > 1
        flushParagraph()
        h = place(addText(inline(match[1]), 24, m.y, m.top.size, m.c.dim), 6)
        addRect(4, m.y - h - 6, 4, h, m.c.line)
        return
    end if
    if m.tableRow.IsMatch(line)
        flushParagraph()
        if not m.tableRule.IsMatch(line) then addRow(tableCells(line), nextIsRule)
        return
    end if
    if line.Trim() = ""
        flushParagraph()
        return
    end if
    m.para.Push(line.Trim())
end sub

sub trimToFit(cutOff as boolean)
    marker = m.top.size + 12
    limit = m.top.maxHeight
    if m.y > limit or cutOff then limit = limit - marker
    bottom = 0
    trimmed = cutOff
    for i = m.top.getChildCount() - 1 to 0 step -1
        node = m.top.getChild(i)
        end_ = node.translation[1] + node.boundingRect().height
        if end_ > limit
            m.top.removeChild(node)
            trimmed = true
        else if end_ > bottom
            bottom = end_
        end if
    end for
    if trimmed then addText("…", 0, bottom + 6, m.top.size, m.c.dim)
end sub

sub render()
    while m.top.getChildCount() > 0
        m.top.removeChildIndex(0)
    end while
    m.y = 0
    m.para = []
    m.codeLines = []
    inCode = false
    cutOff = false
    lines = m.lineBreak.Split(m.top.markdown)
    total = lines.Count()
    for i = 0 to total - 1
        line = lines[i]
        if m.fence.IsMatch(line)
            if inCode then flushCode() else flushParagraph()
            inCode = not inCode
        else if inCode
            m.codeLines.Push(line)
        else
            nextIsRule = i + 1 < total and m.tableRule.IsMatch(lines[i + 1])
            addLine(line, nextIsRule)
        end if
        if m.y > m.top.maxHeight
            cutOff = i < total - 1
            exit for
        end if
    end for
    if inCode and m.codeLines.Count() > 0 then flushCode()
    flushParagraph()
    trimToFit(cutOff)
end sub
