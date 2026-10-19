(module
  (memory (export "memory") 9 9)
  (global $pos (mut i32) (i32.const 0))
  ;; Planar blocks: input 0/2048; output 4096/6144. Maximum 512 frames.
  ;; 32 delay indices at 8192; 32 float coefficients at 8320.
  ;; Independent 65536-sample history buffers begin at 16384 and 278528.
  (func (export "process") (param $frames i32) (param $wet f32) (param $gain f32)
    (local $n i32) (local $c i32) (local $t i32)
    (local $base i32) (local $p i32) (local $x f32) (local $sum f32)
    (block $done (loop $samples
      (br_if $done (i32.ge_u (local.get $n) (local.get $frames)))
      (local.set $p (i32.and (i32.add (global.get $pos) (local.get $n)) (i32.const 65535)))
      (local.set $c (i32.const 0))
      (loop $channels
        (local.set $base (i32.add (i32.const 16384) (i32.mul (local.get $c) (i32.const 262144))))
        (local.set $x (f32.load (i32.add (i32.mul (local.get $c) (i32.const 2048)) (i32.mul (local.get $n) (i32.const 4)))))
        (f32.store (i32.add (local.get $base) (i32.mul (local.get $p) (i32.const 4))) (local.get $x))
        (local.set $sum (f32.const 0))
        (local.set $t (i32.const 0))
        (loop $taps
          (local.set $sum (f32.add (local.get $sum)
            (f32.mul
              (f32.load (i32.add (local.get $base) (i32.mul (i32.and
                (i32.sub (local.get $p) (i32.load (i32.add (i32.const 8192) (i32.mul (local.get $t) (i32.const 4)))))
                (i32.const 65535)) (i32.const 4))))
              (f32.load (i32.add (i32.const 8320) (i32.mul (local.get $t) (i32.const 4)))))))
          (local.set $t (i32.add (local.get $t) (i32.const 1)))
          (br_if $taps (i32.lt_u (local.get $t) (i32.const 32))))
        (f32.store (i32.add (i32.const 4096) (i32.add (i32.mul (local.get $c) (i32.const 2048)) (i32.mul (local.get $n) (i32.const 4))))
          (f32.mul (local.get $gain) (f32.add
            (f32.mul (local.get $x) (f32.sub (f32.const 1) (local.get $wet)))
            (f32.mul (local.get $sum) (local.get $wet)))))
        (local.set $c (i32.add (local.get $c) (i32.const 1)))
        (br_if $channels (i32.lt_u (local.get $c) (i32.const 2))))
      (local.set $n (i32.add (local.get $n) (i32.const 1)))
      (br $samples)))
    (global.set $pos (i32.and (i32.add (global.get $pos) (local.get $frames)) (i32.const 65535))))
)
