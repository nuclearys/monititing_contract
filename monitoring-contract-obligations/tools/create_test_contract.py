from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "test-data" / "Договор_поставки_без_исполнения_2026.docx"


def set_cell_shading(cell, fill):
    properties = cell._tc.get_or_add_tcPr()
    shading = properties.find(qn("w:shd"))
    if shading is None:
        shading = OxmlElement("w:shd")
        properties.append(shading)
    shading.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=100, start=120, bottom=100, end=120):
    properties = cell._tc.get_or_add_tcPr()
    margins = properties.first_child_found_in("w:tcMar")
    if margins is None:
        margins = OxmlElement("w:tcMar")
        properties.append(margins)
    for name, value in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = margins.find(qn(f"w:{name}"))
        if node is None:
            node = OxmlElement(f"w:{name}")
            margins.append(node)
        node.set(qn("w:w"), str(value))
        node.set(qn("w:type"), "dxa")


def set_cell_borders(cell, color="D9D9D9", size="6"):
    properties = cell._tc.get_or_add_tcPr()
    borders = properties.first_child_found_in("w:tcBorders")
    if borders is None:
        borders = OxmlElement("w:tcBorders")
        properties.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = f"w:{edge}"
        element = borders.find(qn(tag))
        if element is None:
            element = OxmlElement(tag)
            borders.append(element)
        element.set(qn("w:val"), "single")
        element.set(qn("w:sz"), size)
        element.set(qn("w:space"), "0")
        element.set(qn("w:color"), color)


def set_row_cant_split(row):
    properties = row._tr.get_or_add_trPr()
    if properties.find(qn("w:cantSplit")) is None:
        properties.append(OxmlElement("w:cantSplit"))


def set_row_repeat_header(row):
    properties = row._tr.get_or_add_trPr()
    if properties.find(qn("w:tblHeader")) is None:
        properties.append(OxmlElement("w:tblHeader"))


def set_run_font(run, name="Arial", size=11, bold=False, italic=False, color="000000"):
    run.font.name = name
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), name)
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.italic = italic
    run.font.color.rgb = RGBColor.from_string(color)


def set_paragraph_spacing(paragraph, before=0, after=6, line=1.15):
    paragraph.paragraph_format.space_before = Pt(before)
    paragraph.paragraph_format.space_after = Pt(after)
    paragraph.paragraph_format.line_spacing = line


def add_paragraph(doc, text="", style=None, align=None, before=0, after=6, line=1.15, bold_prefix=None):
    paragraph = doc.add_paragraph(style=style)
    if align is not None:
        paragraph.alignment = align
    set_paragraph_spacing(paragraph, before, after, line)
    if bold_prefix and text.startswith(bold_prefix):
        first = paragraph.add_run(bold_prefix)
        set_run_font(first, bold=True)
        rest = paragraph.add_run(text[len(bold_prefix):])
        set_run_font(rest)
    else:
        run = paragraph.add_run(text)
        set_run_font(run)
    return paragraph


def add_section_heading(doc, text):
    paragraph = doc.add_paragraph(style="Heading 1")
    set_paragraph_spacing(paragraph, before=12, after=5, line=1.0)
    run = paragraph.add_run(text)
    set_run_font(run, size=13, bold=True)
    return paragraph


def add_clause(doc, number, title, text):
    paragraph = doc.add_paragraph()
    set_paragraph_spacing(paragraph, before=2, after=5, line=1.18)
    number_run = paragraph.add_run(f"{number} {title}. ")
    set_run_font(number_run, bold=True)
    text_run = paragraph.add_run(text)
    set_run_font(text_run)
    return paragraph


def add_obligation_table(doc):
    add_section_heading(doc, "Перечень обязательств")
    add_paragraph(
        doc,
        "Для тестирования системы в таблице перечислены обязательства, по которым на дату подготовки образца отсутствуют записи об исполнении.",
        after=8,
    )
    rows = [
        ("1", "Поставщик обязан поставить оборудование в полном комплекте по адресу Покупателя не позднее 15 ноября 2026 года.", "15.11.2026", "Нефинансовое", "Поставщик"),
        ("2", "Поставщик обязан передать паспорт оборудования, инструкции по эксплуатации и сертификаты соответствия в течение 5 рабочих дней с даты поставки.", "не указан", "Нефинансовое", "Поставщик"),
        ("3", "Поставщик обязан устранить выявленные недостатки или заменить неисправное оборудование в течение 10 календарных дней с даты получения уведомления.", "не указан", "Нефинансовое", "Поставщик"),
        ("4", "Поставщик обязан направлять Покупателю ежемесячный отчет о гарантийном сопровождении до 5 числа месяца, следующего за отчетным.", "05.11.2026", "Нефинансовое", "Поставщик"),
        ("5", "Покупатель обязан оплатить оставшиеся 70 процентов цены договора в течение 10 рабочих дней после подписания акта приема-передачи.", "не указан", "Финансовое", "Покупатель"),
        ("6", "Стороны обязаны не раскрывать третьим лицам техническую и коммерческую информацию, полученную при исполнении договора.", "до 31.12.2028", "Нефинансовое", "Стороны"),
    ]
    table = doc.add_table(rows=1, cols=5)
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    headers = ["№", "Содержание обязательства", "Срок", "Тип", "Ответственная сторона"]
    for index, header in enumerate(headers):
        cell = table.rows[0].cells[index]
        set_cell_shading(cell, "1F4E79")
        set_cell_margins(cell, 110, 120, 110, 120)
        set_cell_borders(cell)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        paragraph = cell.paragraphs[0]
        paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER if index != 1 else WD_ALIGN_PARAGRAPH.LEFT
        set_paragraph_spacing(paragraph, 0, 0, 1.0)
        run = paragraph.add_run(header)
        set_run_font(run, size=9, bold=True, color="FFFFFF")
    set_row_repeat_header(table.rows[0])
    set_row_cant_split(table.rows[0])
    for row_number, row_data in enumerate(rows, start=1):
        cells = table.add_row().cells
        set_row_cant_split(table.rows[-1])
        for index, value in enumerate(row_data):
            cell = cells[index]
            set_cell_shading(cell, "F3F6F8" if row_number % 2 == 0 else "FFFFFF")
            set_cell_margins(cell)
            set_cell_borders(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            paragraph = cell.paragraphs[0]
            paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER if index in (0, 2, 3, 4) else WD_ALIGN_PARAGRAPH.LEFT
            set_paragraph_spacing(paragraph, 0, 0, 1.05)
            run = paragraph.add_run(value)
            set_run_font(run, size=8.7)
    widths = [0.35, 3.65, 0.85, 0.85, 1.05]
    for column, width in zip(table.columns, widths):
        column.width = Inches(width)
        for cell in column.cells:
            cell.width = Inches(width)


def build_document():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    document = Document()
    section = document.sections[0]
    section.page_width = Inches(8.5)
    section.page_height = Inches(11)
    section.top_margin = Inches(0.72)
    section.bottom_margin = Inches(0.72)
    section.left_margin = Inches(0.78)
    section.right_margin = Inches(0.78)

    styles = document.styles
    styles["Normal"].font.name = "Arial"
    styles["Normal"]._element.rPr.rFonts.set(qn("w:ascii"), "Arial")
    styles["Normal"]._element.rPr.rFonts.set(qn("w:hAnsi"), "Arial")
    styles["Normal"].font.size = Pt(11)
    styles["Title"].font.name = "Arial"
    styles["Title"]._element.rPr.rFonts.set(qn("w:ascii"), "Arial")
    styles["Title"]._element.rPr.rFonts.set(qn("w:hAnsi"), "Arial")
    styles["Title"].font.color.rgb = RGBColor(0, 0, 0)
    styles["Heading 1"].font.name = "Arial"
    styles["Heading 1"]._element.rPr.rFonts.set(qn("w:ascii"), "Arial")
    styles["Heading 1"]._element.rPr.rFonts.set(qn("w:hAnsi"), "Arial")
    styles["Heading 1"].font.color.rgb = RGBColor(0, 0, 0)

    title = document.add_paragraph(style="Title")
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_paragraph_spacing(title, 0, 4, 1.0)
    title_run = title.add_run("Договор поставки и сервисного сопровождения")
    set_run_font(title_run, size=18, bold=True)

    subtitle = document.add_paragraph()
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_paragraph_spacing(subtitle, 0, 16, 1.0)
    subtitle_run = subtitle.add_run("Тестовый образец без исполнения обязательств")
    set_run_font(subtitle_run, size=11, italic=True, color="5E6B75")

    meta = document.add_table(rows=3, cols=2)
    meta.alignment = WD_TABLE_ALIGNMENT.CENTER
    meta.autofit = True
    meta_values = [
        ("Номер договора", "ТЕСТ-2026-002"),
        ("Дата и место заключения", "10 октября 2026 года, г. Норильск"),
        ("Статус для тестирования", "Без исполнения обязательств"),
    ]
    for row, (label, value) in zip(meta.rows, meta_values):
        for cell in row.cells:
            set_cell_borders(cell)
            set_cell_margins(cell, 100, 130, 100, 130)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        set_cell_shading(row.cells[0], "EAF2F8")
        set_cell_shading(row.cells[1], "FFFFFF")
        p0, p1 = row.cells[0].paragraphs[0], row.cells[1].paragraphs[0]
        set_paragraph_spacing(p0, 0, 0, 1.0)
        set_paragraph_spacing(p1, 0, 0, 1.0)
        set_run_font(p0.add_run(label), size=10, bold=True)
        set_run_font(p1.add_run(value), size=10)
    add_paragraph(document, "", after=2)

    add_section_heading(document, "Стороны договора")
    add_paragraph(document, "Поставщик — ООО «Северный Контур», именуемое в дальнейшем «Поставщик», в лице генерального директора Иванова Сергея Петровича, действующего на основании Устава.")
    add_paragraph(document, "Покупатель — АО «Полярные Решения», именуемое в дальнейшем «Покупатель», в лице директора по снабжению Смирновой Елены Андреевны, действующей на основании доверенности.")

    add_section_heading(document, "Предмет договора")
    add_clause(document, "1.1", "Поставка", "Поставщик обязуется поставить Покупателю комплект оборудования для производственного участка, а также передать относящуюся к нему техническую документацию. Покупатель обязуется принять оборудование и оплатить его на условиях настоящего договора.")
    add_clause(document, "1.2", "Сервисное сопровождение", "В течение гарантийного периода Поставщик оказывает консультационное и техническое сопровождение оборудования, включая обработку обращений Покупателя и подготовку отчетов о выполненных работах.")

    add_section_heading(document, "Цена и порядок расчетов")
    add_clause(document, "2.1", "Цена договора", "Общая цена договора составляет 12 800 000 (Двенадцать миллионов восемьсот тысяч) рублей, включая НДС 20 процентов.")
    add_clause(document, "2.2", "Аванс", "Покупатель перечисляет аванс в размере 30 процентов цены договора в течение 5 рабочих дней с даты получения счета Поставщика.")
    add_clause(document, "2.3", "Окончательный расчет", "Оставшиеся 70 процентов цены договора оплачиваются в течение 10 рабочих дней после подписания акта приема-передачи оборудования.")

    add_section_heading(document, "Сроки и порядок поставки")
    add_clause(document, "3.1", "Срок поставки", "Поставка выполняется не позднее 15 ноября 2026 года по адресу: Российская Федерация, Красноярский край, г. Норильск, ул. Промышленная, д. 18.")
    add_clause(document, "3.2", "Документы", "Одновременно с оборудованием Поставщик передает паспорт оборудования, инструкции по эксплуатации и сертификаты соответствия в течение 5 рабочих дней с даты поставки.")
    add_clause(document, "3.3", "Устранение недостатков", "При получении письменного уведомления о недостатках Поставщик обязан устранить выявленные недостатки или заменить неисправное оборудование в течение 10 календарных дней.")
    add_clause(document, "3.4", "Ежемесячный отчет", "Поставщик направляет Покупателю отчет о гарантийном сопровождении до 5 числа месяца, следующего за отчетным.")

    add_section_heading(document, "Ответственность и конфиденциальность")
    add_clause(document, "4.1", "Просрочка", "За нарушение срока поставки Поставщик уплачивает пеню в размере 0,1 процента стоимости непоставленного оборудования за каждый день просрочки, но не более 10 процентов указанной стоимости.")
    add_clause(document, "4.2", "Конфиденциальность", "Стороны обязуются не раскрывать третьим лицам техническую и коммерческую информацию, полученную при заключении и исполнении договора, за исключением случаев, предусмотренных законодательством.")
    add_clause(document, "4.3", "Срок конфиденциальности", "Обязанность по неразглашению действует до 31 декабря 2028 года.")

    add_obligation_table(document)

    add_section_heading(document, "Заключительные положения")
    add_clause(document, "5.1", "Изменение договора", "Любые изменения и дополнения к договору действительны только в письменной форме и при подписании уполномоченными представителями обеих сторон.")
    add_clause(document, "5.2", "Срок действия", "Договор вступает в силу с даты подписания и действует до полного исполнения сторонами обязательств.")
    add_clause(document, "5.3", "Тестовая отметка", "На дату подготовки настоящего тестового образца подтверждающие документы об исполнении обязательств отсутствуют. Отметка не является условием договора и предназначена для проверки обработки документа в системе мониторинга.")

    add_section_heading(document, "Реквизиты и подписи сторон")
    signature = document.add_table(rows=3, cols=2)
    signature.alignment = WD_TABLE_ALIGNMENT.CENTER
    signature.autofit = True
    signature_rows = [
        ("Поставщик", "Покупатель"),
        ("ООО «Северный Контур», генеральный директор Иванов С. П.", "АО «Полярные Решения», директор по снабжению Смирнова Е. А."),
        ("________________ / Иванов С. П. /", "________________ / Смирнова Е. А. /"),
    ]
    for row, values in zip(signature.rows, signature_rows):
        for cell, value in zip(row.cells, values):
            set_cell_margins(cell, 100, 130, 100, 130)
            set_cell_borders(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            p = cell.paragraphs[0]
            set_paragraph_spacing(p, 0, 0, 1.0)
            set_run_font(p.add_run(value), size=10, bold=(row is signature.rows[0]))
        if row is signature.rows[0]:
            set_cell_shading(row.cells[0], "EAF2F8")
            set_cell_shading(row.cells[1], "EAF2F8")

    footer = section.footer
    footer_paragraph = footer.paragraphs[0]
    footer_paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_paragraph_spacing(footer_paragraph, 4, 0, 1.0)
    footer_run = footer_paragraph.add_run("Тестовый документ для проверки извлечения обязательств")
    set_run_font(footer_run, size=8, color="6B7280")

    document.core_properties.title = "Договор поставки и сервисного сопровождения"
    document.core_properties.subject = "Тестовый договор без исполнения обязательств"
    document.core_properties.author = "Тестовый контур мониторинга"
    document.save(OUTPUT)
    print(OUTPUT)


if __name__ == "__main__":
    build_document()
