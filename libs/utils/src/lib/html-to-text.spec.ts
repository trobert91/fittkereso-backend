import { htmlToText } from './html-to-text';

describe('htmlToText', () => {
  // From speedbike's Árukereső feed (speedbike-feed-sample.xml, KTM-0233221xx-2023):
  // Word markup, a style attribute broken by its own quotes, and an empty
  // paragraph for spacing.
  const wordMarkup = `<p><p><!--[if gte mso 9]><xml>
 <o:OfficeDocumentSettings>
  <o:AllowPNG/>
 </o:OfficeDocumentSettings>
</xml><![endif]--><!--[if gte mso 10]>
<style>
 table.MsoNormalTable {mso-style-name:"Table Normal";}
</style>
<![endif]-->
</p>
<p class="MsoNormal"><span style="font-size:12.0pt;line-height:107%;font-family:
"Arial",sans-serif">VADÁSZAT RÁD EGY NAP. A KTM eHardtail kínálat kiegyensúlyozott
kezelhetőséget kínál, <b><span style="color:red">a TEAM XL rendszertömege 178 kg.</span></b></span>
</p>
<p class="MsoNormal"><span style="font-size:12.0pt;line-height:107%;font-family:
"Arial",sans-serif">&nbsp;</span>
</p>
<p class="MsoNormal"><span style="font-size:12.0pt;line-height:107%;font-family:
"Arial",sans-serif">A KTM MACINA TEAM XL 2023 JELLEMZŐI</span>
</p>
<p class="MsoNormal"><span style="font-size:12.0pt">- Bosch Performance Line CX motor</span>
</p>
<p class="MsoNormal"><span style="font-size:12.0pt">- PowerTube 750 Wh Akku + Kiox 300 Display</span>
</p>
</p>`;

  it('reads Word markup as its paragraphs, spacing kept, markup and comments dropped', () => {
    expect(htmlToText(wordMarkup)).toBe(
      [
        'VADÁSZAT RÁD EGY NAP. A KTM eHardtail kínálat kiegyensúlyozott kezelhetőséget kínál, a TEAM XL rendszertömege 178 kg.',
        '',
        'A KTM MACINA TEAM XL 2023 JELLEMZŐI',
        '- Bosch Performance Line CX motor',
        '- PowerTube 750 Wh Akku + Kiox 300 Display',
      ].join('\n'),
    );
  });

  it('drops scripts, styles and the head', () => {
    expect(
      htmlToText(
        '<head><title>Shop</title><style>p { color: red }</style></head>' +
          '<p>Könnyű <script>alert("x")</script>váz.</p><style>.a{}</style>',
      ),
    ).toBe('Könnyű váz.');
  });

  it('puts list items on lines of their own', () => {
    expect(htmlToText('<p>Jellemzők:</p><ul><li>Bosch motor</li><li> 625 Wh <b>akku</b></li><li></li></ul>')).toBe(
      ['Jellemzők:', '- Bosch motor', '- 625 Wh akku'].join('\n'),
    );
  });

  it('breaks lines at <br> and headings, and keeps at most one blank line', () => {
    expect(htmlToText('<h2>Motor</h2>Bosch CX<br>85 Nm<br><br><br><br>Akku<div>625 Wh</div>')).toBe(
      ['Motor', 'Bosch CX', '85 Nm', '', 'Akku', '625 Wh'].join('\n'),
    );
  });

  it('keeps table cells apart', () => {
    expect(htmlToText('<table><tr><td>Súly</td><td>24 kg</td></tr><tr><td>Váz</td><td>alu</td></tr></table>')).toBe(
      ['Súly 24 kg', 'Váz alu'].join('\n'),
    );
  });

  it('decodes entities and collapses whitespace', () => {
    expect(htmlToText('<p>  Ár&nbsp;&amp;\n\t  érték &lt;25 km/h&gt; &#8211; &quot;XL&quot;  </p>')).toBe(
      'Ár & érték <25 km/h> – "XL"',
    );
  });

  it('keeps the line breaks of text with no tag at all', () => {
    expect(htmlToText('Első sor\r\nMásodik  sor\n\n\n\nHarmadik &amp; utolsó')).toBe(
      ['Első sor', 'Második sor', '', 'Harmadik & utolsó'].join('\n'),
    );
  });

  // speedbike's description for 953 e-bikes.
  it('leaves an article number as the article number', () => {
    expect(htmlToText('<p>121210</p>')).toBe('121210');
  });

  it('gives an empty string for nothing but markup', () => {
    expect(htmlToText('<p><!-- nothing --></p><p>&nbsp;</p>')).toBe('');
    expect(htmlToText('')).toBe('');
  });
});
