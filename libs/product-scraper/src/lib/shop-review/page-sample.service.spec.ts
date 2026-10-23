import { htmlToText } from '@fittkereso-backend/utils';
import { mainContent } from './page-sample.service';

const filler = 'Hajtás és fékek részletes leírása. '.repeat(20);

describe('mainContent', () => {
  it('keeps the main element and drops the menus, header and footer', () => {
    const html = `<html><body>
      <header><a>Rólunk</a></header>
      <nav><ul><li>Kerékpárok</li><li>Alkatrészek</li></ul></nav>
      <main><h1>Scott Sub Sport eRIDE 20</h1><table><tr><td>Motor típusa:</td><td>Bosch CX (85 Nm)</td></tr></table><p>${filler}</p></main>
      <footer>Kapcsolat</footer>
      <script>var tracking = 1;</script>
    </body></html>`;
    const text = htmlToText(mainContent(html));
    expect(text).toContain('Scott Sub Sport eRIDE 20');
    expect(text).toContain('Bosch CX (85 Nm)');
    expect(text).not.toContain('Kerékpárok');
    expect(text).not.toContain('Rólunk');
    expect(text).not.toContain('Kapcsolat');
    expect(text).not.toContain('tracking');
  });

  it('falls back to the body, without the chrome, when no content element holds enough text', () => {
    const html = `<html><body><nav>Menü</nav><main>rövid</main><div class="termek">${filler}</div></body></html>`;
    const text = htmlToText(mainContent(html));
    expect(text).toContain('rövid');
    expect(text).toContain('Hajtás és fékek');
    expect(text).not.toContain('Menü');
  });
});
