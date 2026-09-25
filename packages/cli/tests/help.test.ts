import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { helpScreen } from '../src/help.js';

const cases: Array<[string[], string]> = [
  [[], '0594bf3f966f7124d1ce047702a6f1de0edcf72d8db1c11767faae837867cd6d'],
  [['install'], '5222336ac38fcbb5786adb1ea4db785f533ea8d876b863e25c3f6c48dbbc20d2'],
  [['status'], '1c29c889b9f1c3b4cf3b94a2c72a5419276813c7cf1e1d3444acb54ea0d8c51a'],
  [['add'], '5ce2e2d07d1e44c55ac1f195e1f3273b0b0f18d83fed215ffd52886990d08544'],
  [['remove'], '934e26698e5be6d3e60a900bf3663b11a76f99d4f51bac9080bcdab3f769c087'],
  [['connect'], '6c9d4881c201d019fc325987b3ff6d09c0910245f4726332e1750702f7e73ce9'],
  [['project'], '550e4cb12dbbcad4224471d7cab14b5b3c44c93243ef2fa7d674420617395507'],
  [['project', 'status'], 'ac91f509f89f40979bdf153762bf6469a757977824513e71c33541f39c204888'],
  [['project', 'init'], '0faf3860f8fb3774377d9d3652720285a3b8c53bd122c221cb3610128f8991cf'],
  [['project', 'link'], 'f301e7f0048618dcdefa9c1b95ab78f179abaaf16766e6741b6b0c978398d30d'],
  [['project', 'setup'], '2b989f13d7656484016664b10947a58f15d1f697796da2195d0e197c02a97843'],
  [['project', 'delete'], '52ada4c76ea7c4ec6f5f7cb5ccf62b65712be2c2a0296128db656cccd6ad29e9'],
  [['project', 'ensure'], '0f118185fa1d51658f384e5d4ae4994b4ee2ea93c7ceda2e03c2373b1eec0da7'],
  [['update'], 'd6e128996980b4d22b7155cae155f7781304ede82ab6531f31a8c8f27e3b7617'],
  [['repair'], '648612f968285f4c86951ec2c6eb1da9869da2bd46746c5d8f64b5396d1ee566'],
  [['doctor'], '8c5a1dc072058497a0b8d5574a3047ea321175429f7992ae0d390fcff1896b38'],
  [['uninstall'], '2f71925d2aae56dc34a2b16ea1c9898b7dd3dfb1c4fbdc64a2bece643aa207d0'],
  [['auth'], 'fce04ee07d96b64f9c89396315c8acde553bda303cba560ac2ee5a3f27cf26fa'],
  [['auth', 'login'], '9422a764f3db2a0e22641b584ef59aa2e0ded0b65c11317d9a8944e950cfec00'],
  [['auth', 'renew'], '0e55b35cd893d792ca29e78576ca8d1b02889ae87e9e8c789015c51f1adef95f'],
  [['auth', 'status'], 'c213604a72102b917a7b66d1e734acea69ad32c903f4da737294a30467d8ab3a'],
  [['auth', 'logout'], 'b04d947896a4c89aec83e5514018e55385f1a3e45da5e882fea9266c16dc67a5'],
  [['logout'], 'c161b3e65f57ca6c2dc4e235a76540541b0168682676e28da4835d68db02bd41'],
  [['scanner'], '9e740af09eb58321ebf476507ddaf44c0706fa31c924556589c20d98c05e0a68'],
  [['scanner', 'enable'], '9ae8369f405db3f0f2558d8c941ccaa5370920c9bbfe1518d612cb25cb916261'],
  [['scanner', 'start'], '9ab8d0d306cd1cda6dc1bfb4ab2f45798b09bf4e4d2fcd892e98c9e34e2e7343'],
  [['scanner', 'stop'], '1f7aebfdf41f4dd9207ff1e6c2ec5d8eef89bfe439701314fb0f6d80f5ade0e1'],
  [['scanner', 'pause'], '346b9a6c17b71ca375abfba216dcd437e663fc7423b51e9a38ffb1908ddc4ff5'],
  [['scanner', 'resume'], '62c6f17a466ef5984bb8082d3dadfe0ffbe868918fda42f2e0a8378efa45519f'],
  [['scanner', 'status'], '032eae080a634f08a429d5685468a20a58890e274546e7528626405021c9abd0'],
  [['scanner', 'uninstall'], 'f3a42cb95f0d93ce18a99d719dabe3f875c53c85341fe36f91ac193ef018432a'],
  [
    ['scanner', 'export-preview'],
    'b95119b1616a97c049bad67d2554ba0f237d23f1acbb3ffa0e0a35d4918c2d83',
  ],
  [['roots'], 'af842c6f07b45bb67a277c5741bd4ad91a4f07bd22b54258bf9c58b5e95b3d32'],
  [['data', 'delete'], '34b127120cd7d9f5e4271cd8f23c336d8b0d825d56160e1a3ad6c08d8580c8c3'],
  [['diagnostics'], '44dd4ee1a8a5b83fb97b181f6bf91a3598d158b1541e3c4a8ea39e2c4d8889cd'],
  [['identity', 'migrate'], '71b47337a51b58da49dc5b866bb3fa3299b04934b4f4b1db5f8f1449a9730ac2'],
];

describe('approved help copy', () => {
  it.each(cases)('returns the exact screen for %j', (path, expectedHash) => {
    const screen = helpScreen(path);
    expect(screen).toBeDefined();
    expect(createHash('sha256').update(screen!).digest('hex')).toBe(expectedHash);
  });

  it('returns undefined for an unknown nested command', () => {
    expect(helpScreen(['project', 'frobnicate'])).toBeUndefined();
  });
});
