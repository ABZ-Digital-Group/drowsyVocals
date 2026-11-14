const path = require('path');
const PDFDocument = require('pdfkit');

const COLORS = {
    ink: '#292752',
    text: '#34334D',
    muted: '#77758C',
    panel: '#F1F0F8',
    rule: '#DAD8E8',
    white: '#FFFFFF'
};

function humanizeLabel(value) {
    const specialLabels = {
        discordId: 'Discord ID',
        accountDiscordId: 'Discord account ID',
        id: 'Record ID',
        loaRequests: 'Leave of absence requests',
        ip: 'IP address'
    };
    if (specialLabels[value]) return specialLabels[value];

    return value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function safeText(value) {
    return String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
}

function formatScalar(key, value) {
    if (value === null || value === undefined || value === '') return 'Not recorded';
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (typeof value === 'string' && /(?:At|Date|Time)$/i.test(key) && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        const date = new Date(value);
        if (Number.isFinite(date.getTime())) {
            return `${date.toLocaleString('en-GB', { timeZone: 'UTC' })} UTC`;
        }
    }
    return safeText(value);
}

function ensureSpace(doc, height) {
    if (doc.y + height > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
    }
}

function measureTextHeight(doc, value, options) {
    const currentY = doc.y;
    const bottomMargin = doc.page.margins.bottom;
    doc.y = doc.page.margins.top;
    doc.page.margins.bottom = 0;
    const height = doc.heightOfString(value, options);
    doc.page.margins.bottom = bottomMargin;
    doc.y = currentY;
    return height;
}

function addHeading(doc, text, depth) {
    const indent = Math.min(depth * 10, 40);
    const x = doc.page.margins.left + indent;
    const width = doc.page.width - doc.page.margins.right - x;
    ensureSpace(doc, 30);

    const y = doc.y;
    doc.roundedRect(x, y, width, 21, 4).fill(COLORS.panel);
    doc.font('Helvetica-Bold')
        .fontSize(depth === 0 ? 11 : 9.5)
        .fillColor(COLORS.ink)
        .text(safeText(text), x + 8, y + 5, { width: width - 16, lineBreak: false });
    doc.y = y + 27;
}

function addField(doc, label, value, depth) {
    const indent = Math.min(depth * 10, 40);
    const x = doc.page.margins.left + indent;
    const rightEdge = doc.page.width - doc.page.margins.right;
    const labelWidth = Math.max(100, 145 - indent);
    const valueX = x + labelWidth + 8;
    const valueWidth = rightEdge - valueX;
    const labelText = safeText(label);
    const valueText = safeText(value);

    doc.font('Helvetica-Bold').fontSize(8.5);
    const labelHeight = measureTextHeight(doc, labelText, { width: labelWidth });
    doc.font('DrowsySans').fontSize(9);
    const valueHeight = measureTextHeight(doc, valueText, { width: valueWidth });
    const rowHeight = Math.max(labelHeight, valueHeight, 11) + 7;
    ensureSpace(doc, rowHeight);

    const y = doc.y;
    doc.font('Helvetica-Bold')
        .fontSize(8.5)
        .fillColor(COLORS.ink)
        .text(labelText, x, y, { width: labelWidth });
    doc.font('DrowsySans')
        .fontSize(9)
        .fillColor(COLORS.text)
        .text(valueText, valueX, y, { width: valueWidth });
    doc.y = y + rowHeight;
}

function renderCompactTable(doc, label, rows, keys, depth) {
    const indent = Math.min(depth * 10, 40);
    const x = doc.page.margins.left + indent;
    const width = doc.page.width - doc.page.margins.right - x;
    const weightFor = (key) => (/id/i.test(key) ? 1 : /date|time|at$/i.test(key) ? 1.4 : 2);
    const totalWeight = keys.reduce((total, key) => total + weightFor(key), 0);
    const columnWidths = keys.map((key) => (width * weightFor(key)) / totalWeight);

    addHeading(doc, `${label} (${rows.length})`, depth);

    const addHeader = () => {
        ensureSpace(doc, 24);
        const y = doc.y;
        doc.roundedRect(x, y, width, 20, 3).fill(COLORS.ink);
        let columnX = x;
        keys.forEach((key, index) => {
            doc.font('Helvetica-Bold')
                .fontSize(7.5)
                .fillColor(COLORS.white)
                .text(humanizeLabel(key), columnX + 4, y + 5, {
                    width: columnWidths[index] - 8,
                    lineBreak: false
                });
            columnX += columnWidths[index];
        });
        doc.y = y + 23;
    };

    addHeader();
    rows.forEach((row, rowIndex) => {
        const values = keys.map((key) => {
            const value = row[key];
            return formatScalar(key, value);
        });
        doc.font('DrowsySans').fontSize(7.5);
        const cellHeights = values.map((value, index) => measureTextHeight(doc, safeText(value), {
            width: columnWidths[index] - 8
        }));
        const rowHeight = Math.max(17, ...cellHeights.map((height) => height + 6));
        if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
            doc.addPage();
            addHeader();
        }

        const y = doc.y;
        if (rowIndex % 2 === 0) {
            doc.rect(x, y, width, rowHeight).fill('#FAF9FC');
        }
        let columnX = x;
        values.forEach((value, index) => {
            doc.font('DrowsySans')
                .fontSize(7.5)
                .fillColor(COLORS.text)
                .text(safeText(value), columnX + 4, y + 3, {
                    width: columnWidths[index] - 8
                });
            columnX += columnWidths[index];
        });
        doc.strokeColor(COLORS.rule)
            .moveTo(x, y + rowHeight)
            .lineTo(x + width, y + rowHeight)
            .stroke();
        doc.y = y + rowHeight + 1;
    });
}

function renderValue(doc, label, value, depth = 0) {
    if (Array.isArray(value)) {
        if (value.length === 0) {
            addHeading(doc, `${label} (0)`, depth);
            addField(doc, 'Records', 'None', depth + 1);
            return;
        }

        const objectRows = value.every((item) => item && typeof item === 'object' && !Array.isArray(item));
        const tableKeys = objectRows
            ? [...new Set(value.flatMap((item) => Object.keys(item)))]
            : [];
        const scalarRows = objectRows && value.every((item) => Object.values(item).every(
            (child) => child === null || ['string', 'number', 'boolean'].includes(typeof child)
        ));
        if (value.length >= 40 && scalarRows && tableKeys.length > 0 && tableKeys.length <= 5) {
            renderCompactTable(doc, label, value, tableKeys, depth);
            return;
        }

        addHeading(doc, `${label} (${value.length})`, depth);
        value.forEach((item, index) => {
            if (item && typeof item === 'object') {
                addField(doc, 'Record', String(index + 1), depth + 1);
                Object.entries(item).forEach(([key, child]) => {
                    renderValue(doc, humanizeLabel(key), child, depth + 2);
                });
            } else {
                addField(doc, `Entry ${index + 1}`, formatScalar(label, item), depth + 1);
            }
        });
        return;
    }

    if (value && typeof value === 'object') {
        addHeading(doc, label, depth);
        const entries = Object.entries(value);
        if (entries.length === 0) {
            addField(doc, 'Details', 'None', depth + 1);
            return;
        }
        entries.forEach(([key, child]) => {
            renderValue(doc, humanizeLabel(key), child, depth + 1);
        });
        return;
    }

    addField(doc, label, formatScalar(label, value), depth);
}

function createPrivacyDataExportPdf(exportData) {
    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 54, right: 48, bottom: 56, left: 48 },
        bufferPages: true,
        info: {
            Title: 'Drowsy Vocals Personal Data Copy',
            Author: 'Drowsy Vocals',
            Subject: 'Private personal data copy'
        }
    });
    doc.registerFont('DrowsySans', path.join(__dirname, '..', 'public', 'css', 'Satoshi-Variable.ttf'));

    const pageWidth = doc.page.width;
    doc.rect(0, 0, pageWidth, 148).fill(COLORS.ink);
    doc.font('Helvetica-Bold')
        .fontSize(11)
        .fillColor(COLORS.white)
        .text('DROWSY VOCALS', doc.page.margins.left, 34, { characterSpacing: 1.2 });
    doc.font('Helvetica-Bold')
        .fontSize(23)
        .text('Personal data copy', doc.page.margins.left, 60);
    doc.font('DrowsySans')
        .fontSize(9)
        .fillColor('#E7E5F2')
        .text(`Generated ${formatScalar('generatedAt', exportData?.export?.generatedAt || new Date().toISOString())}`, doc.page.margins.left, 105);

    doc.y = 171;
    const accountName = exportData?.account?.displayName || exportData?.account?.discordUser || 'Account holder';
    addField(doc, 'Prepared for', safeText(accountName), 0);
    addField(doc, 'Discord ID', formatScalar('discordId', exportData?.account?.login?.discordId || exportData?.export?.accountDiscordId), 0);
    addField(doc, 'Export format', 'PDF · formatted for reading', 0);
    doc.y += 8;

    Object.entries(exportData || {}).forEach(([key, value]) => {
        renderValue(doc, humanizeLabel(key), value, 0);
    });

    const pages = doc.bufferedPageRange();
    for (let pageIndex = pages.start; pageIndex < pages.start + pages.count; pageIndex += 1) {
        doc.switchToPage(pageIndex);
        const bottomMargin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.save();
        doc.font('DrowsySans')
            .fontSize(7)
            .fillColor(COLORS.muted)
            .text('PRIVATE PERSONAL DATA · For the account holder only', doc.page.margins.left, doc.page.height - 34, {
                width: 330,
                lineBreak: false
            });
        doc.strokeColor(COLORS.rule)
            .moveTo(doc.page.margins.left, doc.page.height - 42)
            .lineTo(doc.page.width - doc.page.margins.right, doc.page.height - 42)
            .stroke();
        doc.font('DrowsySans')
            .fontSize(7)
            .fillColor(COLORS.muted)
            .text(`Page ${pageIndex + 1} of ${pages.count}`, doc.page.width - doc.page.margins.right - 70, doc.page.height - 34, {
                width: 70,
                align: 'right',
                lineBreak: false
            });
        doc.restore();
        doc.page.margins.bottom = bottomMargin;
    }

    return doc;
}

module.exports = { createPrivacyDataExportPdf };
