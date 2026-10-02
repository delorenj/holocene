import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;

class WrapperChecksumCheck {
    public static void main(String[] args) throws Exception {
        String pin = Files.readAllLines(Path.of(args[0])).stream()
            .filter(line -> line.startsWith("distributionSha256Sum="))
            .findFirst().orElseThrow().split("=", 2)[1];
        if (!pin.matches("[0-9a-f]{64}")) throw new AssertionError("Invalid SHA256 pin length/format");
        Class.forName("org.gradle.wrapper.Install")
            .getMethod("verifyDownloadChecksum", String.class, File.class, String.class)
            .invoke(null, "https://services.gradle.org/distributions/gradle-8.11.1-bin.zip", new File(args[1]), pin);
        System.out.println("Exact wrapper Install.verifyDownloadChecksum passed: " + pin);
    }
}
