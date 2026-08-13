using Nikse.SubtitleEdit.Core.BluRaySup;
using Nikse.SubtitleEdit.Core.Common;
using Nikse.SubtitleEdit.Core.VobSub;
using SkiaSharp;

if (args.Length != 1)
{
    Console.Error.WriteLine("Usage: author <output-directory>");
    return 2;
}

var glyphs = new Dictionary<char, byte[]>
{
    ['A'] = [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001],
    ['B'] = [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110],
    ['E'] = [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111],
    ['G'] = [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01110],
    ['J'] = [0b00111, 0b00010, 0b00010, 0b00010, 0b10010, 0b10010, 0b01100],
    ['M'] = [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001],
    ['O'] = [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
    ['P'] = [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000],
    ['S'] = [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110],
    ['T'] = [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100],
    ['U'] = [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110],
    ['V'] = [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100],
    ['1'] = [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
    ['2'] = [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
    ['3'] = [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
};

var outputDirectory = Path.GetFullPath(args[0]);
Directory.CreateDirectory(outputDirectory);
var subPath = Path.Combine(outputDirectory, "jumpgate-vobsub-3cue.sub");

using (var writer = new VobSubWriter(
           subPath, 720, 480, bottomMargin: 38, leftRightMargin: 20,
           languageStreamId: 32, SKColors.White, SKColors.Black,
           useInnerAntiAliasing: false, DvdSubtitleLanguage.English))
{
    WriteCue(writer, glyphs, "JUMPGATE VOBSUB 1", 2_000, 5_000);
    WriteCue(writer, glyphs, "JUMPGATE VOBSUB 2", 7_000, 10_000);
    WriteCue(writer, glyphs, "JUMPGATE VOBSUB 3", 12_000, 15_000);
    writer.WriteIdxFile();
}

return 0;

static void WriteCue(VobSubWriter writer, Dictionary<char, byte[]> glyphs, string text, double startMs, double endMs)
{
    const int scale = 6;
    const int glyphWidth = 5;
    const int glyphHeight = 7;
    const int spacing = 1;
    const int padding = 10;
    var width = padding * 2 + (text.Length * (glyphWidth + spacing) - spacing) * scale;
    var height = padding * 2 + glyphHeight * scale;

    using var bitmap = new SKBitmap(new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
    bitmap.Erase(SKColors.Transparent);
    using var canvas = new SKCanvas(bitmap);
    using var outline = new SKPaint { Color = SKColors.Black, Style = SKPaintStyle.Fill, IsAntialias = false };
    using var fill = new SKPaint { Color = SKColors.White, Style = SKPaintStyle.Fill, IsAntialias = false };

    for (var i = 0; i < text.Length; i++)
    {
        if (text[i] == ' ') continue;
        var rows = glyphs[text[i]];
        for (var y = 0; y < glyphHeight; y++)
        {
            for (var x = 0; x < glyphWidth; x++)
            {
                if ((rows[y] & (1 << (glyphWidth - 1 - x))) == 0) continue;
                var left = padding + (i * (glyphWidth + spacing) + x) * scale;
                var top = padding + y * scale;
                canvas.DrawRect(left - 2, top - 2, scale + 4, scale + 4, outline);
            }
        }
    }

    for (var i = 0; i < text.Length; i++)
    {
        if (text[i] == ' ') continue;
        var rows = glyphs[text[i]];
        for (var y = 0; y < glyphHeight; y++)
        {
            for (var x = 0; x < glyphWidth; x++)
            {
                if ((rows[y] & (1 << (glyphWidth - 1 - x))) == 0) continue;
                var left = padding + (i * (glyphWidth + spacing) + x) * scale;
                var top = padding + y * scale;
                canvas.DrawRect(left, top, scale, scale, fill);
            }
        }
    }

    writer.WriteParagraph(
        new Paragraph(text, startMs, endMs), bitmap,
        BluRayContentAlignment.BottomCenter);
}
