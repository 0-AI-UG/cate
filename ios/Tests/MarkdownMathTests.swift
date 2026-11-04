// Run: swiftc ios/Cate/App/MarkdownMath.swift ios/Cate/App/MarkdownBlocks.swift
//      ios/Tests/MarkdownMathTests.swift -o /tmp/cate-math-tests && /tmp/cate-math-tests
import Foundation

@main
enum MarkdownMathTests {
    static func main() {
        let gaussian = #"$$ f(x)=\frac{1}{\sigma\sqrt{2\pi}}\exp\left(-\frac{(x-\mu)^2}{2\sigma^2}\right) $$"#
        let cases: [(String, String)] = [
            (gaussian, gaussian),
            ("$$\nf(x)=\\frac{1}{\\sigma\\sqrt{2\\pi}}\\exp\\left(-\\frac{(x-\\mu)^2}{2\\sigma^2}\\right)\n$$", "$$ f(x)=\\frac{1}{\\sigma\\sqrt{2\\pi}}\\exp\\left(-\\frac{(x-\\mu)^2}{2\\sigma^2}\\right) $$"),
            ("$$\n\\begin{aligned}a &= b \\\\ c &= d\\end{aligned}\n$$", "$$ \\begin{aligned}a &= b \\\\ c &= d\\end{aligned} $$"),
            ("`$$\na\n$$`", "`$$\na\n$$`"),
            (#"Here, \(\mu\) is the mean and \(\sigma>0\) is the standard deviation."#,
             #"Here, $\mu$ is the mean and $\sigma>0$ is the standard deviation."#),
            (#"\[x^2\]"#, "$$x^2$$"),
            (#"$x$ and $$y$$"#, #"$x$ and $$y$$"#),
            (#"`\(code\)` and \(x\)"#, #"`\(code\)` and $x$"#),
            (#"``a ` \(code\)`` and \(x\)"#, #"``a ` \(code\)`` and $x$"#),
            ("```tex\n\\(code\\)\n```\n\\(x\\)", "```tex\n\\(code\\)\n```\n$x$"),
            ("~~~~\n\\[code\\]\n~~~~\n\\[x\\]", "~~~~\n\\[code\\]\n~~~~\n$$x$$"),
            ("```tex\n\\(unfinished code\\)", "```tex\n\\(unfinished code\\)"),
            ("    \\(code\\)\n\n\\(x\\)", "    \\(code\\)\n\n$x$"),
            (#"Unfinished \(x"#, #"Unfinished \(x"#),
            (#"Escaped \\(x\\)"#, #"Escaped \\(x\\)"#),
            ("Emoji 🐈 \\(x\\)", "Emoji 🐈 $x$"),
        ]
        for (input, expected) in cases {
            let actual = MarkdownMath.normalize(input)
            precondition(actual == expected, "\(input.debugDescription): \(actual.debugDescription) != \(expected.debugDescription)")
        }
        let display = "$$ a +  b $$"
        let multiline = "$$\na +\n\nb\n$$"
        precondition(MarkdownBlocks.split("Before\n\n\(multiline)\n\nAfter") == ["Before", display, "After"])
        precondition(MarkdownBlocks.split("\\[\na +\n\nb\n\\]") == [display])
        precondition(MarkdownBlocks.split("```tex\n$$\n\n\\(x\\)\n```\n\nAfter") == ["```tex\n$$\n\n\\(x\\)\n```", "After"])
        precondition(MarkdownBlocks.split("One\n\nTwo") == ["One", "Two"])
        precondition(MarkdownBlocks.split("Before\n$$x^2$$\nAfter") == ["Before", "$$x^2$$", "After"])
        precondition(MarkdownMath.isDisplayBlock(gaussian))
        precondition(MarkdownMath.isDisplayBlock("```math\nx^2\n```"))
        precondition(!MarkdownMath.isDisplayBlock("```tex\nx^2\n```"))
        precondition(!MarkdownMath.isDisplayBlock("Before $$x^2$$"))
        precondition(!MarkdownMath.isDisplayBlock("$$x$$ and $$y$$"))
        print("Passed \(cases.count) normalization cases, 5 block-splitting cases and display-block checks")
    }
}
