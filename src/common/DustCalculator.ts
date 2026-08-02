export class DustCalculator {
  dustLimitFactor: number
  dustAmount: number = null
  constructor(dustLimitFactor: number, dustAmount: number) {
    this.dustLimitFactor = dustLimitFactor
    this.dustAmount = dustAmount
  }

  getDustThreshold(s: number) {
    // ⚠️ 游戏合约输出统一 1 sat（MVC 允许 1 sat 合约输出且可花费；P2PKH 找零不受影响）。
    //    存档链 SPACE 预算 100000 才能支撑 init 链（身份/anchor/realm/cultivate/history + FT mint 多笔）
    return 1
  }
}
